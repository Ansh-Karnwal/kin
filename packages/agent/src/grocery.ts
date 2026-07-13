import { generateJson, LITE_MODEL } from "./llm.js";
import { buildUtilitySystemPrompt, JSON_ONLY } from "./prompts.js";
import { buildSerializedState } from "./db.js";
import {
  getGroceryItems,
  addGroceryItem,
  fulfillGroceryItem,
  removeGroceryItem,
  deleteAllFulfilledGrocery,
  setConfig,
} from "./db.js";
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
  const stateBlock = await buildSerializedState();
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
    systemInstruction: buildUtilitySystemPrompt("the grocery list parser", stateBlock),
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

/** Case-insensitive loose match: "milk" matches "oat milk" and vice versa. */
function matchesItem(listed: string, wanted: string): boolean {
  const a = listed.toLowerCase();
  const b = wanted.toLowerCase();
  return a.includes(b) || b.includes(a);
}

/** Apply a parsed intent to the DB and return Hearth's terse confirmation. */
export async function applyGroceryIntent(intent: GroceryIntent): Promise<string> {
  switch (intent.action) {
    case "add": {
      const current = await getGroceryItems(true);
      const added: string[] = [];
      const dupes: string[] = [];
      for (const item of intent.items) {
        const name = item.toLowerCase().trim();
        if (!name) continue;
        if (current.some((g) => matchesItem(g.item, name))) {
          dupes.push(name);
          continue;
        }
        const id = crypto.randomUUID();
        await addGroceryItem(id, name, intent.requestedBy);
        added.push(name);
      }
      if (added.length === 0 && dupes.length > 0) return `${dupes.join(" + ")} already on there`;
      if (added.length === 0) return "nothing to add?";
      const ack = `added ${added.join(" + ")} 🛒`;
      return dupes.length > 0 ? `${ack} (${dupes.join(" + ")} already on there)` : ack;
    }

    case "fulfill":
    case "remove": {
      const current = await getGroceryItems(true);
      const hit: string[] = [];
      const miss: string[] = [];
      for (const item of intent.items) {
        const target = current.find((g) => matchesItem(g.item, item));
        if (!target) {
          miss.push(item.toLowerCase());
          continue;
        }
        if (intent.action === "fulfill") {
          await fulfillGroceryItem(target.id);
        } else {
          await removeGroceryItem(target.id);
        }
        hit.push(target.item);
      }
      if (hit.length === 0) return `didn't see ${miss.join(" or ") || "that"} on the list`;
      const verb = intent.action === "fulfill" ? "crossed off" : "took off";
      const ack = `${verb} ${hit.join(" + ")} 👍`;
      return miss.length > 0 ? `${ack} (no ${miss.join(" or ")} on there tho)` : ack;
    }

    case "query":
      return formatGroceryList();
  }
}

export async function formatGroceryList(): Promise<string> {
  const items = await getGroceryItems(true);
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
  if (t.includes("what's on the list") || t.includes("whats on the list")) return "compile";
  return null;
}

/** Marks the run as done: stamps lastGroceryRun and removes fulfilled items. */
export async function doGroceryRun(now: Date = new Date()): Promise<string> {
  const reply = await formatGroceryList();
  await Promise.all([
    setConfig("last_grocery_run", now.toISOString()),
    deleteAllFulfilledGrocery(),
  ]);
  log("grocery.run", {});
  return reply;
}
