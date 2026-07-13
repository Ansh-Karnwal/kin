import { GoogleGenAI, type FunctionDeclaration } from "@google/genai";
import { log } from "./log.js";

/** Main agent model: frontier reasoning for chat and state-aware responses. */
export const MAIN_MODEL = "gemini-2.5-flash";
/** Classifier/parser model: fast and cheap for JSON extraction tasks. */
export const LITE_MODEL = "gemini-2.0-flash-lite";

// Gemini free tier: 15 RPM on Flash; keep one slot in reserve.
const MAX_REQUESTS_PER_MINUTE = 14;

/**
 * Sliding-window rate limiter. Callers await acquire() before each API call;
 * requests beyond the per-minute budget queue FIFO and drain as the window rolls.
 */
class RateLimiter {
  private starts: number[] = [];
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly maxPerMinute: number) {}

  acquire(): Promise<void> {
    const slot = this.chain.then(() => this.waitForSlot());
    this.chain = slot;
    return slot;
  }

  private async waitForSlot(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.starts = this.starts.filter((t) => now - t < 60_000);
      if (this.starts.length < this.maxPerMinute) {
        this.starts.push(now);
        return;
      }
      const oldest = this.starts[0];
      const waitMs = 60_000 - (now - oldest) + 100;
      log("gemini.rate_limited", { waitMs });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

const limiter = new RateLimiter(MAX_REQUESTS_PER_MINUTE);

let ai: GoogleGenAI | null = null;

function getAI(): GoogleGenAI {
  if (!ai) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY is not set — add it to the root .env");
    ai = new GoogleGenAI({ apiKey: key });
  }
  return ai;
}

export interface GenerateOptions {
  model?: string;
  systemInstruction: string;
  prompt: string;
}

/** Simple single-turn text generation. Used by parsers and classifier. */
export async function generateText(opts: GenerateOptions): Promise<string> {
  await limiter.acquire();
  const response = await getAI().models.generateContent({
    model: opts.model ?? MAIN_MODEL,
    config: { systemInstruction: opts.systemInstruction },
    contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
  });
  return (response.text ?? "").trim();
}

function stripCodeFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

/**
 * Call Gemini expecting a JSON-only response. Returns null on API error or
 * unparseable output — callers pick their own fallback.
 */
export async function generateJson<T>(opts: GenerateOptions): Promise<T | null> {
  try {
    const raw = await generateText({ ...opts, model: opts.model ?? LITE_MODEL });
    return JSON.parse(stripCodeFences(raw)) as T;
  } catch (err) {
    log("gemini.json_failed", { error: String(err) });
    return null;
  }
}

export interface ToolLoopOptions {
  systemInstruction: string;
  tools: FunctionDeclaration[];
  message: string;
  dispatch: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Max rounds before giving up (default 10). */
  maxRounds?: number;
}

/**
 * Multi-turn Gemini function-calling loop. Runs until the model returns plain
 * text (no more function calls) or maxRounds is exhausted. Each sendMessage
 * call goes through the rate limiter.
 */
export async function runToolLoop(opts: ToolLoopOptions): Promise<string> {
  const maxRounds = opts.maxRounds ?? 10;
  await limiter.acquire();

  const chat = getAI().chats.create({
    model: MAIN_MODEL,
    config: {
      systemInstruction: opts.systemInstruction,
      tools: [{ functionDeclarations: opts.tools }],
    },
  });

  let response = await chat.sendMessage({ message: opts.message });
  let rounds = 0;

  while (response.functionCalls && response.functionCalls.length > 0 && rounds < maxRounds) {
    rounds++;
    const functionResponses: Array<{ functionResponse: { name: string; response: Record<string, unknown> } }> = [];

    for (const call of response.functionCalls) {
      const callName = call.name ?? "unknown";
      log("tool.call", { name: callName, args: JSON.stringify(call.args) });
      let result: unknown;
      try {
        result = await opts.dispatch(callName, ((call.args as Record<string, unknown>) ?? {}));
      } catch (err) {
        log("tool.error", { name: callName, error: String(err) });
        result = { error: String(err) };
      }
      functionResponses.push({
        functionResponse: {
          name: callName,
          // Gemini requires the response to be a plain object
          response: typeof result === "object" && result !== null
            ? (result as Record<string, unknown>)
            : { value: result },
        },
      });
    }

    await limiter.acquire();
    response = await chat.sendMessage({ message: functionResponses });
  }

  if (rounds >= maxRounds) {
    log("gemini.tool_loop_maxed", { rounds });
  }

  return (response.text ?? "").trim();
}
