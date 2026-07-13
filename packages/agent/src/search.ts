// ── web_search ─────────────────────────────────────────────────────────────────
//
// Grounded web lookup for vendor phone numbers, bill-spike checks, product
// lookups, quote comparisons. Uses Perplexity Sonar when PERPLEXITY_API_KEY is
// set (returns source URLs); otherwise falls back to a plain Nebius completion so
// the tool still answers (ungrounded, no sources).

import { log } from "./log.js";
import { generateText } from "./llm.js";

export interface WebSearchResult {
  text: string;
  sources: string[];
}

export async function webSearch(query: string): Promise<WebSearchResult> {
  const key = process.env.PERPLEXITY_API_KEY;

  if (key) {
    try {
      const res = await fetch("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: process.env.PERPLEXITY_MODEL ?? "sonar",
          messages: [
            {
              role: "system",
              content: "Be concise and factual. When asked for a phone number or address, return it plainly.",
            },
            { role: "user", content: query },
          ],
        }),
      });
      if (!res.ok) throw new Error(`perplexity ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        citations?: string[];
      };
      const text = data.choices?.[0]?.message?.content?.trim() ?? "";
      const sources = Array.isArray(data.citations) ? data.citations : [];
      log("search.perplexity", { query: query.slice(0, 80), sources: sources.length });
      return { text, sources };
    } catch (err) {
      log("search.perplexity_failed", { error: String(err) });
      // fall through to Nebius
    }
  }

  // Ungrounded fallback — no live web, but better than nothing for the demo.
  const text = await generateText({
    systemInstruction:
      "You answer factual lookup questions concisely from your own knowledge. If you are not sure, say so plainly. Do not invent phone numbers or addresses.",
    prompt: query,
  });
  log("search.nebius_fallback", { query: query.slice(0, 80) });
  return { text, sources: [] };
}
