import { generateJson, LITE_MODEL } from "./llm.js";
import { buildUtilitySystemPrompt, JSON_ONLY } from "./prompts.js";
import { buildSerializedState, getPendingItems, addPendingItem as addPendingItemDb, resolvePendingItem } from "./db.js";
import { log } from "./log.js";
import type { PendingItem } from "./state.js";

interface ParsedItem {
  description: string;
  deadline?: string;
}

function isParsedItem(v: unknown): v is ParsedItem {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.description === "string" &&
    (obj.deadline === undefined || typeof obj.deadline === "string")
  );
}

export async function parsePendingItem(
  text: string,
  sender: string
): Promise<PendingItem | null> {
  const now = new Date();
  const stateBlock = await buildSerializedState();

  const prompt = `Does this message express something that needs to be done but hasn't been assigned to anyone yet?

Message from ${sender}: "${text}"
Current time: ${now.toISOString()}

${JSON_ONLY}
If it IS an open action item: {"description": string, "deadline": string (ISO timestamp only if a specific time was mentioned, otherwise omit)}
If not: null

IS an action item:
- "we should make a dinner reservation at 7pm" → {"description": "make dinner reservation", "deadline": "<today 19:00 ISO>"}
- "someone needs to get toilet paper" → {"description": "get toilet paper"}
- "we should call the landlord about the heat" → {"description": "call landlord about the heat"}

NOT an action item:
- "i made the reservation" (already done)
- "add milk to the list" (direct command to hearth — handled separately)
- "lol we really need to clean" (vague complaint, not clearly actionable)
- "who's getting groceries?" (question, not a statement of need)`;

  const result = await generateJson<ParsedItem | null>({
    model: LITE_MODEL,
    systemInstruction: buildUtilitySystemPrompt("the action item parser", stateBlock),
    prompt,
  });

  if (result === null || !isParsedItem(result)) return null;

  const item: PendingItem = {
    id: crypto.randomUUID(),
    description: result.description,
    raisedBy: sender,
    raisedAt: now.toISOString(),
    deadline: result.deadline,
    resolved: false,
  };

  log("pending.parsed", {
    description: item.description,
    deadline: item.deadline ?? null,
    raisedBy: sender,
  });
  return item;
}

interface ResolutionCheck {
  resolvedIds: string[];
}

export async function checkResolution(
  text: string,
  sender: string
): Promise<string[]> {
  const open = await getPendingItems(true);
  if (open.length === 0) return [];

  const stateBlock = await buildSerializedState();
  const itemList = open
    .map((i) => `id:${i.id} — "${i.description}" (raised by ${i.raisedBy})`)
    .join("\n");

  const prompt = `Does this message confirm that any of these open action items got handled?

Message from ${sender}: "${text}"

Open items:
${itemList}

${JSON_ONLY}
{"resolvedIds": string[]}

Return the ids of items this message resolves. Empty array if none.
Resolves: "done", "i made the reservation", "got the toilet paper", "called the landlord", "picked it up"
Does not resolve: questions, unrelated chat, new action items`;

  const result = await generateJson<ResolutionCheck>({
    model: LITE_MODEL,
    systemInstruction: buildUtilitySystemPrompt("the resolution checker", stateBlock),
    prompt,
  });

  return result?.resolvedIds ?? [];
}

export async function applyPendingItem(item: PendingItem): Promise<void> {
  await addPendingItemDb(item);
}

export async function resolveItems(ids: string[], resolvedBy: string): Promise<PendingItem[]> {
  const now = new Date().toISOString();
  const open = await getPendingItems(true);
  const toResolve = open.filter((i) => ids.includes(i.id));
  await Promise.all(toResolve.map((i) => resolvePendingItem(i.id, resolvedBy, now)));
  return toResolve.map((i) => ({ ...i, resolved: true, resolvedAt: now, resolvedBy }));
}

export function buildPendingAck(item: PendingItem): string {
  const timeHint = item.deadline
    ? ` — i'll check back if no one's on it by ${new Date(item.deadline).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
    : "";
  return `noted${timeHint}`;
}

export function buildResolutionAck(items: PendingItem[]): string {
  if (items.length === 1) return `nice, "${items[0].description}" ✓`;
  return `got it — ${items.map((i) => `"${i.description}"`).join(", ")} ✓`;
}
