import { GoogleGenerativeAI } from "@google/generative-ai";
import { log } from "./log.js";

/** Main agent model: free, fast, big context window for full-state injection. */
export const MAIN_MODEL = "gemini-1.5-flash";
/** Classifier/parser model: lighter on free-tier quota. */
export const LITE_MODEL = "gemini-1.5-flash-8b";

// Gemini free tier allows 15 RPM on Flash; keep one in reserve for safety.
const MAX_REQUESTS_PER_MINUTE = 14;

/**
 * Sliding-window rate limiter. Callers await acquire() before each API call;
 * requests beyond the per-minute budget queue up FIFO and drain as the
 * window rolls forward.
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

let client: GoogleGenerativeAI | null = null;

function getClient(): GoogleGenerativeAI {
  if (!client) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error("GEMINI_API_KEY is not set — add it to the root .env");
    client = new GoogleGenerativeAI(key);
  }
  return client;
}

export interface GenerateOptions {
  model?: string;
  systemInstruction: string;
  prompt: string;
}

export async function generateText(opts: GenerateOptions): Promise<string> {
  await limiter.acquire();
  const model = getClient().getGenerativeModel({
    model: opts.model ?? MAIN_MODEL,
    systemInstruction: opts.systemInstruction,
  });
  const result = await model.generateContent(opts.prompt);
  return result.response.text().trim();
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
 * unparseable output — callers pick their own fallback (classifier fails
 * open, parsers fail to "not a match").
 */
export async function generateJson<T>(opts: GenerateOptions): Promise<T | null> {
  try {
    const raw = await generateText({ ...opts, model: opts.model ?? LITE_MODEL });
    // Shape is enforced by the prompt; callers validate the fields they rely on.
    return JSON.parse(stripCodeFences(raw)) as T;
  } catch (err) {
    log("gemini.json_failed", { error: String(err) });
    return null;
  }
}
