import { generateJson, LITE_MODEL } from "./gemini.js";
import { buildUtilitySystemPrompt, JSON_ONLY } from "./prompts.js";
import { serializeState, state } from "./state.js";
import { log } from "./log.js";

export type GroceryAction = "add" | "remove" | "fulfill" | "query";

export interface GroceryIntent {
  action: GroceryAction;
  items: string[];
  requestedBy: string;
}

const VALID_ACTIONS: readonly string[] = ["add", "remove", "fulfill", "query"];

function isGroceryIntent(value: unknown): value is GroceryIntent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.action === "string" &&
    VALID_ACTIONS.includes(v.action) &&
    Array.isArray(v.items) &&
    (v.items as unknown[]).every((i) => typeof i === "string") &&
    typeof v.requestedBy === "string"
  );
}

export async function parseGroceryIntent(
  text: string,
  sender: string
): Promise<GroceryIntent | null> {
  const prompt = `Does this message change or ask about the shared grocery list? Extract the intent if yes, return null if no.

Message from ${sender}: "${text}"

${JSON_ONLY}
If grocery-related: {"action": "add" | "remove" | "fulfill" | "query", "items": string[], "requestedBy": string}
If not about the grocery list: null

Rules:
- "add": they want something put on the list — trigger words like "we're out of", "grab", "need", "add", "can someone get"
- "fulfill": an item on the list was bought — trigger words like "got it", "bought", "picked up"
- "remove": they want an item taken off without buying it — trigger words like "remove", "crossed off", "never mind the"
- "query": they're asking what's on the list
- items: short lowercase item names (e.g. "oat milk", not "some of that oat milk maya likes"); empty array for "query"
- requestedBy: "${sender}" unless the message attributes it to someone else, or "everyone" for shared staples
- return null if no concrete items and it's not a query`;

  const result = await generateJson<GroceryIntent | null>({
    model: LITE_MODEL,
    systemInstruction: buildUtilitySystemPrompt("the grocery list parser", serializeState()),
    prompt,
  });

  if (result === null || !isGroceryIntent(result)) return null;

  log("grocery.parsed", {
    action: result.action,
    items: result.items,
    requestedBy: result.requestedBy,
  });
  return result;
}

function openItems() {
  return state.groceryList.filter((g) => !g.fulfilled);
}

/** Case-insensitive loose match: "milk" matches "oat milk" and vice versa. */
function matchesItem(listed: string, wanted: string): boolean {
  const a = listed.toLowerCase();
  const b = wanted.toLowerCase();
  return a.includes(b) || b.includes(a);
}

/** Apply a parsed intent to state and return Hearth's terse confirmation. */
export function applyGroceryIntent(intent: GroceryIntent): string {
  switch (intent.action) {
    case "add": {
      const added: string[] = [];
      const dupes: string[] = [];
      for (const item of intent.items) {
        const name = item.toLowerCase().trim();
        if (!name) continue;
        if (openItems().some((g) => matchesItem(g.item, name))) {
          dupes.push(name);
          continue;
        }
        state.groceryList.push({
          item: name,
          requestedBy: intent.requestedBy,
          addedAt: new Date().toISOString(),
          fulfilled: false,
        });
        added.push(name);
      }
      if (added.length === 0 && dupes.length > 0)
        return `${dupes.join(" + ")} already on there`;
      if (added.length === 0) return "nothing to add?";
      const ack = `added ${added.join(" + ")} 🛒`;
      return dupes.length > 0 ? `${ack} (${dupes.join(" + ")} already on there)` : ack;
    }

    case "fulfill":
    case "remove": {
      const hit: string[] = [];
      const miss: string[] = [];
      for (const item of intent.items) {
        const target = openItems().find((g) => matchesItem(g.item, item));
        if (!target) {
          miss.push(item.toLowerCase());
          continue;
        }
        if (intent.action === "fulfill") {
          target.fulfilled = true;
        } else {
          state.groceryList.splice(state.groceryList.indexOf(target), 1);
        }
        hit.push(target.item);
      }
      if (hit.length === 0)
        return `didn't see ${miss.join(" or ") || "that"} on the list`;
      const verb = intent.action === "fulfill" ? "crossed off" : "took off";
      const ack = `${verb} ${hit.join(" + ")} 👍`;
      return miss.length > 0 ? `${ack} (no ${miss.join(" or ")} on there tho)` : ack;
    }

    case "query":
      return formatGroceryList();
  }
}

export function formatGroceryList(): string {
  const items = openItems();
  if (items.length === 0) return "list's empty, we're good 🧾";
  const lines = items.map(
    (g) => `— ${g.item.toLowerCase()} (${g.requestedBy.toLowerCase()})`
  );
  return `grocery list 🧾\n${lines.join("\n")}`;
}

export type CompileCommand = "run" | "compile";

/** Deterministic match for compile/run phrases — no model call needed. */
export function matchCompileCommand(text: string): CompileCommand | null {
  const t = text.toLowerCase();
  if (/\b(do|doing|do(in'?)?)\s+the\s+grocery\s+run\b/.test(t)) return "run";
  if (t.includes("compile the list")) return "compile";
  if (t.includes("what's on the list") || t.includes("whats on the list"))
    return "compile";
  return null;
}

/** Marks the run as done: stamps lastGroceryRun and clears fulfilled items. */
export function doGroceryRun(now: Date = new Date()): string {
  const reply = formatGroceryList();
  state.lastGroceryRun = now.toISOString();
  state.groceryList = state.groceryList.filter((g) => !g.fulfilled);
  log("grocery.run", { remaining: state.groceryList.length });
  return reply;
}
