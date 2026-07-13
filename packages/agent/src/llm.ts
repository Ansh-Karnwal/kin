import OpenAI from "openai";
import { log } from "./log.js";

/**
 * Nebius AI Studio is OpenAI-compatible: we point the official `openai` SDK at
 * its base URL and use native function calling, JSON mode, and vision.
 */
export const nebius = new OpenAI({
  baseURL: "https://api.studio.nebius.com/v1/",
  apiKey: process.env.NEBIUS_API_KEY!,
});

/**
 * Model roles map to the old Gemini ones. Names shift on the Nebius dashboard —
 * keep them in env so we can retune without a redeploy.
 */
export const MODELS = {
  // was gemini-2.5-flash → strong tool-calling, large context for full-state injection.
  orchestrator: process.env.NEBIUS_ORCHESTRATOR_MODEL!,
  // was gemini-2.0-flash-lite → cheap+fast classifier/extractors.
  fast: process.env.NEBIUS_FAST_MODEL!,
  // vision VLM for image inputs (receipts, photos).
  vision: process.env.NEBIUS_VISION_MODEL!,
};

/**
 * Back-compat role aliases. The rest of the codebase refers to models by these
 * names; keeping them avoids touching every caller.
 */
export const MAIN_MODEL = MODELS.orchestrator;
export const LITE_MODEL = MODELS.fast;

// Nebius RPM is plan-dependent — config-driven so it's not hardcoded. Keep one
// slot in reserve below the configured budget.
const MAX_REQUESTS_PER_MINUTE = Number(process.env.NEBIUS_RPM) || 60;

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
      log("llm.rate_limited", { waitMs });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

const limiter = new RateLimiter(MAX_REQUESTS_PER_MINUTE);

export interface GenerateOptions {
  model?: string;
  systemInstruction: string;
  prompt: string;
}

/** Simple single-turn text generation. Used by parsers and the landlord drafter. */
export async function generateText(opts: GenerateOptions): Promise<string> {
  await limiter.acquire();
  const res = await nebius.chat.completions.create({
    model: opts.model ?? MAIN_MODEL,
    messages: [
      { role: "system", content: opts.systemInstruction },
      { role: "user", content: opts.prompt },
    ],
  });
  return (res.choices[0]?.message?.content ?? "").trim();
}

function stripCodeFences(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
}

/**
 * Call the fast model in JSON mode expecting a JSON-only response. Returns null
 * on API error or unparseable output — callers pick their own fallback.
 */
export async function generateJson<T>(opts: GenerateOptions): Promise<T | null> {
  try {
    await limiter.acquire();
    const res = await nebius.chat.completions.create({
      model: opts.model ?? LITE_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: opts.systemInstruction },
        { role: "user", content: opts.prompt },
      ],
    });
    const raw = res.choices[0]?.message?.content ?? "";
    return JSON.parse(stripCodeFences(raw)) as T;
  } catch (err) {
    log("llm.json_failed", { error: String(err) });
    return null;
  }
}

export interface ToolLoopOptions {
  systemInstruction: string;
  tools: any[]; // OpenAI tool format: { type: "function", function: {...} }
  message: string;
  /** Prior turns of the group chat, oldest first. Lets "yes"/"the grocery list" make sense. */
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  dispatch: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Max rounds before giving up (default 10). */
  maxRounds?: number;
}

/**
 * Multi-turn function-calling loop. Runs until the model returns plain text (no
 * more tool calls) or maxRounds is exhausted. Each completion goes through the
 * rate limiter. Uses the OpenAI message shape: the assistant turn carrying
 * tool_calls is pushed back before the matching role:"tool" result messages.
 */
export async function runToolLoop(opts: ToolLoopOptions): Promise<string> {
  const maxRounds = opts.maxRounds ?? 10;

  const messages: any[] = [
    // /no_think disables Qwen3's reasoning mode so tool calls go through the API correctly.
    { role: "system", content: `/no_think\n${opts.systemInstruction}` },
    ...(opts.history ?? []),
    { role: "user", content: opts.message },
  ];

  for (let rounds = 0; rounds < maxRounds; rounds++) {
    await limiter.acquire();
    const res = await nebius.chat.completions.create({
      model: MAIN_MODEL,
      messages,
      tools: opts.tools,
      tool_choice: "auto",
    });

    const msg = res.choices[0].message;
    // Qwen3 thinking mode emits <think>…</think> content alongside tool_calls.
    // Echoing both back causes Nebius to return 400; strip content when tool_calls are present.
    messages.push(
      msg.tool_calls?.length
        ? { ...msg, content: null }
        : msg
    );

    const calls = msg.tool_calls;
    if (!calls || calls.length === 0) {
      return (msg.content ?? "").trim();
    }

    for (const call of calls) {
      if (call.type !== "function") continue;
      const callName = call.function.name;
      let args: Record<string, unknown> = {};
      try {
        // OpenAI gives args as a JSON *string* — parse them.
        args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
      } catch (err) {
        log("tool.bad_args", { name: callName, error: String(err) });
      }
      log("tool.call", { name: callName, args: JSON.stringify(args) });

      let result: unknown;
      try {
        result = await opts.dispatch(callName, args);
      } catch (err) {
        log("tool.error", { name: callName, error: String(err) });
        result = { error: String(err) };
      }

      messages.push({
        role: "tool",
        tool_call_id: call.id, // MUST echo the id back, or the call errors
        content: JSON.stringify(result ?? null),
      });
    }
  }

  log("llm.tool_loop_maxed", { rounds: maxRounds });
  return "got a bit tangled on that one, can you say it again simpler?";
}
