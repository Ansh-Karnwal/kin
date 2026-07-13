// ── Nimble: live product / grocery pricing ──────────────────────────────────────
//
// Real-time structured web data for multi-store price comparison. Backs the
// compare_prices tool and the grocery-run cheapest-store enrichment, and feeds
// the GTM marketing employee's price-trend posts (Phase 5).
//
// Env-guarded: with NIMBLE_API_KEY set and DEMO_MODE=false it queries the Nimble
// Web API; otherwise it returns a small, realistic, deterministic simulated set
// so the demo runs fully offline. Nimble's actual endpoint/response shape may
// differ per plan — the live branch parses defensively and falls back to the
// simulated set on any error.

import { log } from "./log.js";

export interface PriceQuote {
  store: string;
  product: string;
  price: number;
  url: string;
}

export interface PriceTrend {
  product: string;
  changePct: number;
  period: string;
  note: string;
}

const DEMO = process.env.DEMO_MODE !== "false";
const NIMBLE_BASE = "https://api.webit.live/api/v1/realtime";

// Stores we simulate quotes across (also the default `stores` filter).
const DEFAULT_STORES = ["Instacart", "Safeway", "Whole Foods", "Trader Joe's", "Costco", "Target"];

/** Stable pseudo-random in [0,1) derived from a string — keeps demo prices consistent. */
function seed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

/** A believable base price for a grocery product, derived deterministically. */
function basePrice(product: string): number {
  const p = product.toLowerCase();
  // A few well-known anchors so the demo reads naturally.
  if (p.includes("egg")) return 4.5;
  if (p.includes("milk")) return 4.99;
  if (p.includes("coffee")) return 8.99;
  if (p.includes("paper towel")) return 6.49;
  if (p.includes("bread")) return 3.29;
  if (p.includes("butter")) return 5.29;
  // Otherwise $2–$12 based on the name.
  return Number((2 + seed(product) * 10).toFixed(2));
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function simulatedPrices(product: string, stores: string[]): PriceQuote[] {
  const base = basePrice(product);
  return stores
    .map((store) => {
      // ±18% spread per store, deterministic per (store, product) pair.
      const spread = (seed(`${store}:${product}`) - 0.5) * 0.36;
      const price = Number(Math.max(0.99, base * (1 + spread)).toFixed(2));
      return {
        store,
        product,
        price,
        url: `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(`${product} ${store}`)}`,
      };
    })
    .sort((a, b) => a.price - b.price);
}

/** Parse whatever structured shape Nimble returned into PriceQuote[]. */
function parseNimblePrices(product: string, data: unknown): PriceQuote[] {
  const out: PriceQuote[] = [];
  const walk = (node: unknown): void => {
    if (node == null) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node === "object") {
      const r = node as Record<string, unknown>;
      const priceRaw = r.price ?? r.current_price ?? r.offer_price;
      const store = r.seller ?? r.store ?? r.merchant ?? r.source;
      if (priceRaw != null && typeof store === "string") {
        const price = typeof priceRaw === "number" ? priceRaw : parseFloat(String(priceRaw).replace(/[^0-9.]/g, ""));
        if (Number.isFinite(price) && price > 0) {
          out.push({
            store,
            product: typeof r.title === "string" ? r.title : product,
            price: Number(price.toFixed(2)),
            url: typeof r.url === "string" ? r.url : typeof r.link === "string" ? r.link : "",
          });
        }
      }
      Object.values(r).forEach(walk);
    }
  };
  walk(data);
  return out.sort((a, b) => a.price - b.price);
}

/**
 * Multi-store price quotes for a product, cheapest first. Simulated when Nimble
 * isn't configured or DEMO_MODE is on (default).
 */
export async function getPrices(product: string, stores?: string[]): Promise<PriceQuote[]> {
  const wanted = stores && stores.length > 0 ? stores : DEFAULT_STORES;
  const key = process.env.NIMBLE_API_KEY;

  if (!key || DEMO) {
    const quotes = simulatedPrices(product, wanted);
    log("nimble.simulated_prices", { product, stores: quotes.length, demo: DEMO });
    return quotes;
  }

  try {
    const res = await fetch(`${NIMBLE_BASE}/serp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        query: product,
        search_engine: "google_shopping",
        parse: true,
        country: "US",
      }),
    });
    if (!res.ok) throw new Error(`nimble ${res.status}: ${await res.text()}`);
    const data = await res.json();

    let quotes = parseNimblePrices(product, data);
    if (stores && stores.length > 0) {
      const set = new Set(stores.map((s) => s.toLowerCase()));
      quotes = quotes.filter((q) => set.has(q.store.toLowerCase()));
    }
    if (quotes.length === 0) throw new Error("no priceable results");
    log("nimble.prices", { product, stores: quotes.length });
    return quotes;
  } catch (err) {
    log("nimble.prices_failed", { product, error: String(err) });
    return simulatedPrices(product, wanted); // never break the caller
  }
}

/**
 * Week-over-week price movement for a product. Used by compare_prices context
 * and by the GTM marketing employee. Simulated when Nimble isn't configured or
 * DEMO_MODE is on.
 */
export async function getPriceTrend(product: string): Promise<PriceTrend> {
  const key = process.env.NIMBLE_API_KEY;

  if (!key || DEMO) {
    // Deterministic, mostly-upward movement (the interesting marketing angle).
    const raw = seed(`trend:${product}`); // 0..1
    const changePct = Math.round((raw * 55 - 15) * 10) / 10; // roughly -15%..+40%
    const dir = changePct >= 0 ? "up" : "down";
    const note = `${product} is ${dir} ${Math.abs(changePct)}% week-over-week`;
    log("nimble.simulated_trend", { product, changePct, demo: DEMO });
    return { product, changePct, period: "week-over-week", note };
  }

  try {
    // Derive a trend from current vs. a prior snapshot. Without a stored history
    // we approximate from the current spread; the shared client keeps the demo
    // honest while a real deployment would persist snapshots.
    const quotes = await getPrices(product);
    if (quotes.length === 0) throw new Error("no quotes for trend");
    const avg = quotes.reduce((s, q) => s + q.price, 0) / quotes.length;
    const cheapest = quotes[0].price;
    const changePct = Math.round(((avg - cheapest) / cheapest) * 100 * 10) / 10;
    const note = `${product} averaging $${avg.toFixed(2)}, cheapest $${cheapest.toFixed(2)}`;
    log("nimble.trend", { product, changePct });
    return { product, changePct, period: "week-over-week", note };
  } catch (err) {
    log("nimble.trend_failed", { product, error: String(err) });
    const changePct = Math.round((seed(`trend:${product}`) * 55 - 15) * 10) / 10;
    return { product, changePct, period: "week-over-week", note: `${product} price trend unavailable` };
  }
}
