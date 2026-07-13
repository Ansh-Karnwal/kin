// ── web_search ─────────────────────────────────────────────────────────────────
//
// Grounded web lookup for vendor phone numbers, bill-spike checks, product
// lookups, quote comparisons. Backend precedence:
//   1. You.com   — citation-backed search across web/news/research/deep endpoints
//   2. Perplexity Sonar — grounded, returns source URLs
//   3. Nebius    — ungrounded completion so the tool still answers (no sources)
// Each tier falls through to the next on missing key or error, so demos always
// return something and never crash.

import { log } from "./log.js";
import { generateText } from "./llm.js";

export interface WebSearchResult {
  text: string;
  sources: string[];
}

/** You.com endpoint families. Callers can request one; default comes from env. */
export type SearchMode = "web" | "news" | "research" | "deep";

// You.com v1 API. Search is GET on ydc-index.io with X-API-KEY; research is
// POST on api.you.com with Bearer auth. v1 has no separate news endpoint.
const YOU_SEARCH_URL = "https://ydc-index.io/v1/search";
const YOU_RESEARCH_URL = "https://api.you.com/v1/research";

function defaultMode(): SearchMode {
  const m = (process.env.YOU_SEARCH_ENDPOINT ?? "web").toLowerCase();
  return m === "news" || m === "research" || m === "deep" ? m : "web";
}

/** Recursively collect http(s) URLs from any `url`/`link`/`source` fields. */
function collectUrls(node: unknown, out: Set<string>): void {
  if (node == null) return;
  if (Array.isArray(node)) {
    for (const v of node) collectUrls(v, out);
    return;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if ((k === "url" || k === "link" || k === "source") && typeof v === "string" && /^https?:\/\//.test(v)) {
        out.add(v);
      } else {
        collectUrls(v, out);
      }
    }
  }
}

/** Build a readable text blob from whichever fields You.com returned. */
function extractYouText(data: Record<string, unknown>): string {
  // Research returns { output: { content } }; other synthesized shapes use flat keys.
  const output = data.output as Record<string, unknown> | undefined;
  if (typeof output?.content === "string" && output.content.trim()) {
    return output.content.trim();
  }
  for (const key of ["answer", "summary", "text", "response"]) {
    const v = data[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }

  // Search returns { results: { web: [...] } }; older shapes used hits/results arrays.
  const buckets: unknown[] = [];
  const results = data.results;
  if (Array.isArray(results)) buckets.push(...results);
  else if (typeof results === "object" && results != null) {
    const web = (results as Record<string, unknown>).web;
    if (Array.isArray(web)) buckets.push(...web);
  }
  if (Array.isArray(data.hits)) buckets.push(...(data.hits as unknown[]));

  const lines: string[] = [];
  for (const h of buckets.slice(0, 6)) {
    if (typeof h !== "object" || h == null) continue;
    const r = h as Record<string, unknown>;
    const title = typeof r.title === "string" ? r.title : "";
    const snippets = Array.isArray(r.snippets)
      ? (r.snippets as unknown[]).filter((s) => typeof s === "string").join(" ")
      : "";
    const desc = typeof r.description === "string" ? r.description : "";
    const body = (snippets || desc).trim();
    const line = [title, body].filter(Boolean).join(" — ");
    if (line) lines.push(line);
  }
  return lines.join("\n");
}

async function youSearch(query: string, mode: SearchMode): Promise<WebSearchResult | null> {
  const key = process.env.YOU_API_KEY;
  if (!key) return null;
  try {
    let res: Response;
    if (mode === "research" || mode === "deep") {
      res = await fetch(YOU_RESEARCH_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ input: query }),
      });
    } else {
      // "news" maps here too — v1 has no separate news endpoint.
      const url = new URL(YOU_SEARCH_URL);
      url.searchParams.set("query", query);
      url.searchParams.set("count", "10");
      res = await fetch(url.toString(), {
        headers: { "X-API-KEY": key, Accept: "application/json" },
      });
    }
    if (!res.ok) throw new Error(`you.com ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as Record<string, unknown>;

    const text = extractYouText(data);
    const urls = new Set<string>();
    collectUrls(data, urls);
    const sources = [...urls];

    if (!text && sources.length === 0) throw new Error("empty you.com response");
    log("search.youcom", { mode, query: query.slice(0, 80), sources: sources.length });
    return { text, sources };
  } catch (err) {
    log("search.youcom_failed", { mode, error: String(err) });
    return null; // fall through to Perplexity / Nebius
  }
}

async function perplexitySearch(query: string): Promise<WebSearchResult | null> {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) return null;
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
    return null; // fall through to Nebius
  }
}

/**
 * Grounded web search. `mode` selects the You.com endpoint family (defaults to
 * YOU_SEARCH_ENDPOINT). All existing callers pass a single arg and keep working.
 */
export async function webSearch(query: string, mode?: SearchMode): Promise<WebSearchResult> {
  const you = await youSearch(query, mode ?? defaultMode());
  if (you) return you;

  const pplx = await perplexitySearch(query);
  if (pplx) return pplx;

  // Ungrounded fallback — no live web, but better than nothing for the demo.
  const text = await generateText({
    systemInstruction:
      "You answer factual lookup questions concisely from your own knowledge. If you are not sure, say so plainly. Do not invent phone numbers or addresses.",
    prompt: query,
  });
  log("search.nebius_fallback", { query: query.slice(0, 80) });
  return { text, sources: [] };
}
