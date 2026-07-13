import { log } from "./log.js";

export interface PriceTrend {
  product: string;
  changePct: number;
  period: string;
  note: string;
}

export interface DraftResponse {
  post: string;
}

const AGENT_PORT = Number(process.env.AGENT_PORT) || 3000;
const AGENT_BASE = process.env.GTM_AGENT_API_BASE || `http://localhost:${AGENT_PORT}`;

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${AGENT_BASE}${path}`, init);
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

export async function fetchTrend(product?: string): Promise<PriceTrend> {
  const qs = product ? `?product=${encodeURIComponent(product)}` : "";
  const trend = await requestJson<PriceTrend>(`/gtm/trend${qs}`);
  log("gtm.trend_fetched", { product: trend.product, changePct: trend.changePct });
  return trend;
}

export async function draftPost(trend: PriceTrend): Promise<string> {
  const body = JSON.stringify({ trend });
  const result = await requestJson<DraftResponse>("/gtm/draft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  log("gtm.draft_fetched", { chars: result.post.length });
  return result.post;
}
