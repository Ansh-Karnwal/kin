import { consumptionPatterns, state, type ConsumptionPattern } from "./state.js";
import { log } from "./log.js";

// ── Consumption pattern tracking ──────────────────────────────────────────────

/** Called after every fulfilled grocery run to update consumption data. */
export function updateConsumptionPattern(itemName: string, requester: string): void {
  const key = itemName.toLowerCase().trim();
  const now = new Date().toISOString();
  const existing = consumptionPatterns.get(key);

  if (!existing) {
    const id = `cp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    consumptionPatterns.set(key, {
      id,
      itemName: key,
      avgDaysBetweenOrders: undefined, // needs 2+ orders to calculate
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
  // Rolling average (geometric decay towards recent)
  const newAvg =
    prevAvg === undefined
      ? daysSinceLast
      : Math.round(prevAvg * 0.7 + daysSinceLast * 0.3);

  // Add requester if new
  if (!existing.typicalRequesters.includes(requester)) {
    existing.typicalRequesters.push(requester);
  }

  existing.avgDaysBetweenOrders = newAvg;
  existing.lastOrderedAt = now;
  existing.timesOrdered += 1;
  existing.updatedAt = now;

  log("reorder.pattern_updated", { item: key, newAvg, daysSinceLast, timesOrdered: existing.timesOrdered });
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

export function suggestReorder(args: SuggestReorderArgs): {
  suggestions: ReorderSuggestion[];
  message: string;
  keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  const now = Date.now();
  const openGroceryItems = new Set(
    state.groceryList.filter((g) => !g.fulfilled).map((g) => g.item.toLowerCase())
  );

  const suggestions: ReorderSuggestion[] = [];

  for (const pattern of consumptionPatterns.values()) {
    // Skip items with fewer than 2 orders (no reliable interval yet)
    if (pattern.timesOrdered < 2 || pattern.avgDaysBetweenOrders === undefined) continue;

    // Skip items already on the grocery list
    if (openGroceryItems.has(pattern.itemName)) continue;

    const daysSinceLast = Math.floor(
      (now - Date.parse(pattern.lastOrderedAt)) / 86_400_000
    );

    // Suggest when 85% of the average interval has elapsed
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

  // For mention-triggered: prioritise the mentioned item first
  if (args.triggered_by === "mention" && args.item_mentioned) {
    const mentioned = args.item_mentioned.toLowerCase();
    suggestions.sort((a, b) => {
      if (a.itemName.includes(mentioned)) return -1;
      if (b.itemName.includes(mentioned)) return 1;
      return 0;
    });
  }

  if (suggestions.length === 0) {
    return {
      suggestions: [],
      message: "nothing seems due for reorder right now",
      keyboard: [],
    };
  }

  const itemList = suggestions
    .slice(0, 5) // cap at 5 to keep the message short
    .map((s) => s.itemName)
    .join(", ");

  const callbackItems = suggestions
    .slice(0, 5)
    .map((s) => s.itemName)
    .join(",");

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
export function applyReorderAdd(itemsCsv: string, requestedBy: string = "auto-reorder"): string {
  const items = itemsCsv.split(",").map((s) => s.trim()).filter(Boolean);
  const added: string[] = [];

  for (const item of items) {
    const alreadyOn = state.groceryList.some(
      (g) => !g.fulfilled && g.item.toLowerCase() === item.toLowerCase()
    );
    if (!alreadyOn) {
      state.groceryList.push({
        item: item.toLowerCase(),
        requestedBy,
        addedAt: new Date().toISOString(),
        fulfilled: false,
      });
      added.push(item);
    }
  }

  if (added.length === 0) return "already on the list";
  return `added ${added.join(", ")} to the list 🛒`;
}

/** Whether the daily reorder check should post (cap: once per item per 7 days). */
const recentlySuggested = new Map<string, number>();

export function shouldSuggestDailyReorder(): boolean {
  const now = Date.now();
  // Clean up stale entries
  for (const [item, ts] of recentlySuggested.entries()) {
    if (now - ts > 7 * 86_400_000) recentlySuggested.delete(item);
  }

  // Count how many patterns are due and not recently suggested
  let eligible = 0;
  for (const pattern of consumptionPatterns.values()) {
    if (pattern.timesOrdered < 2 || pattern.avgDaysBetweenOrders === undefined) continue;
    if (recentlySuggested.has(pattern.itemName)) continue;
    const daysSinceLast = Math.floor((now - Date.parse(pattern.lastOrderedAt)) / 86_400_000);
    if (daysSinceLast >= pattern.avgDaysBetweenOrders * 0.85) eligible++;
  }

  return eligible >= 2; // only nag when 2+ items are due
}

export function markSuggestedItems(items: string[]): void {
  const now = Date.now();
  for (const item of items) recentlySuggested.set(item.toLowerCase(), now);
}
