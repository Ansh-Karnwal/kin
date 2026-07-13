import {
  getAllConsumptionPatterns,
  getConsumptionPattern,
  upsertConsumptionPattern,
  getGroceryItems,
} from "./db.js";
import type { ConsumptionPattern } from "./state.js";
import { log } from "./log.js";

// ── Consumption pattern tracking ──────────────────────────────────────────────

/** Called after every fulfilled grocery run to update consumption data. */
export async function updateConsumptionPattern(itemName: string, requester: string): Promise<void> {
  const key = itemName.toLowerCase().trim();
  const now = new Date().toISOString();
  const existing = await getConsumptionPattern(key);

  if (!existing) {
    const id = crypto.randomUUID();
    await upsertConsumptionPattern({
      id,
      itemName: key,
      avgDaysBetweenOrders: undefined,
      lastOrderedAt: now,
      timesOrdered: 1,
      typicalRequesters: [requester],
      updatedAt: now,
    });
    return;
  }

  const daysSinceLast = Math.floor(
    (Date.now() - Date.parse(existing.lastOrderedAt)) / 86_400_000
  );

  const prevAvg = existing.avgDaysBetweenOrders;
  const newAvg =
    prevAvg === undefined
      ? daysSinceLast
      : Math.round(prevAvg * 0.7 + daysSinceLast * 0.3);

  const typicalRequesters = existing.typicalRequesters.includes(requester)
    ? existing.typicalRequesters
    : [...existing.typicalRequesters, requester];

  await upsertConsumptionPattern({
    ...existing,
    avgDaysBetweenOrders: newAvg,
    lastOrderedAt: now,
    timesOrdered: existing.timesOrdered + 1,
    typicalRequesters,
    updatedAt: now,
  });

  log("reorder.pattern_updated", { item: key, newAvg, daysSinceLast, timesOrdered: existing.timesOrdered + 1 });
}

// ── Suggest reorder ───────────────────────────────────────────────────────────

interface SuggestReorderArgs {
  triggered_by: "mention" | "scheduled";
  item_mentioned?: string;
}

export interface ReorderSuggestion {
  itemName: string;
  daysSinceLast: number;
  avgInterval: number;
  typicalRequesters: string[];
}

export async function suggestReorder(args: SuggestReorderArgs): Promise<{
  suggestions: ReorderSuggestion[];
  message: string;
  keyboard: Array<Array<{ text: string; callback_data: string }>>;
}> {
  const now = Date.now();
  const openGroceries = await getGroceryItems(true);
  const openGroceryNames = new Set(openGroceries.map((g) => g.item.toLowerCase()));

  const patterns = await getAllConsumptionPatterns();
  const suggestions: ReorderSuggestion[] = [];

  for (const pattern of patterns) {
    if (pattern.timesOrdered < 2 || pattern.avgDaysBetweenOrders === undefined) continue;
    if (openGroceryNames.has(pattern.itemName)) continue;

    const daysSinceLast = Math.floor(
      (now - Date.parse(pattern.lastOrderedAt)) / 86_400_000
    );

    const threshold = pattern.avgDaysBetweenOrders * 0.85;

    if (daysSinceLast >= threshold) {
      suggestions.push({
        itemName: pattern.itemName,
        daysSinceLast,
        avgInterval: pattern.avgDaysBetweenOrders,
        typicalRequesters: pattern.typicalRequesters,
      });
    }
  }

  if (args.triggered_by === "mention" && args.item_mentioned) {
    const mentioned = args.item_mentioned.toLowerCase();
    suggestions.sort((a, b) => {
      if (a.itemName.includes(mentioned)) return -1;
      if (b.itemName.includes(mentioned)) return 1;
      return 0;
    });
  }

  if (suggestions.length === 0) {
    return { suggestions: [], message: "nothing seems due for reorder right now", keyboard: [] };
  }

  const itemList = suggestions.slice(0, 5).map((s) => s.itemName).join(", ");
  const callbackItems = suggestions.slice(0, 5).map((s) => s.itemName).join(",");

  const message =
    `heads up — you usually reorder ${itemList} around now ` +
    `(last got ${suggestions.length === 1 ? "it" : "them"} ${suggestions[0].daysSinceLast} days ago). ` +
    `want me to add ${suggestions.length === 1 ? "it" : "them"}?`;

  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [[
    { text: "Add to list", callback_data: `reorder:add:${callbackItems}` },
    { text: "Ignore", callback_data: "reorder:ignore" },
  ]];

  log("reorder.suggestions", { count: suggestions.length, items: itemList, triggeredBy: args.triggered_by });

  return { suggestions, message, keyboard };
}

/** Bulk-add suggested items to the grocery list. Returns an ack message. */
export async function applyReorderAdd(itemsCsv: string, requestedBy: string = "auto-reorder"): Promise<string> {
  const items = itemsCsv.split(",").map((s) => s.trim()).filter(Boolean);
  const current = await getGroceryItems(true);
  const currentNames = new Set(current.map((g) => g.item.toLowerCase()));
  const added: string[] = [];

  for (const item of items) {
    const name = item.toLowerCase();
    if (!currentNames.has(name)) {
      const { addGroceryItem } = await import("./db.js");
      const id = crypto.randomUUID();
      await addGroceryItem(id, name, requestedBy);
      added.push(item);
    }
  }

  if (added.length === 0) return "already on the list";
  return `added ${added.join(", ")} to the list 🛒`;
}

/** Rate-limiter: skip re-suggesting the same item within 7 days (in-memory, resets on restart). */
const recentlySuggested = new Map<string, number>();

export async function shouldSuggestDailyReorder(): Promise<boolean> {
  const now = Date.now();
  for (const [item, ts] of recentlySuggested.entries()) {
    if (now - ts > 7 * 86_400_000) recentlySuggested.delete(item);
  }

  const patterns = await getAllConsumptionPatterns();
  let eligible = 0;
  for (const pattern of patterns) {
    if (pattern.timesOrdered < 2 || pattern.avgDaysBetweenOrders === undefined) continue;
    if (recentlySuggested.has(pattern.itemName)) continue;
    const daysSinceLast = Math.floor((now - Date.parse(pattern.lastOrderedAt)) / 86_400_000);
    if (daysSinceLast >= pattern.avgDaysBetweenOrders * 0.85) eligible++;
  }

  return eligible >= 2;
}

export function markSuggestedItems(items: string[]): void {
  const now = Date.now();
  for (const item of items) recentlySuggested.set(item.toLowerCase(), now);
}
