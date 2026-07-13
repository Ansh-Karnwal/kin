import { generateJson, LITE_MODEL } from "./gemini.js";
import { JSON_ONLY, buildUtilitySystemPrompt } from "./prompts.js";
import { serializeState } from "./state.js";
import { log } from "./log.js";

export type MessageType =
  | "expense"
  | "grocery"
  | "chore"
  | "action_item"
  | "query"
  | "banter"
  | "maintenance"
  | "calendar"
  | "other";

export interface Classification {
  relevant: boolean;
  type: MessageType;
  confidence: "high" | "low";
}

const FAIL_OPEN: Classification = { relevant: true, type: "other", confidence: "low" };

const VALID_TYPES: readonly string[] = [
  "expense", "grocery", "chore", "action_item", "query",
  "banter", "maintenance", "calendar", "other",
];

function isClassification(value: unknown): value is Classification {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.relevant === "boolean" &&
    typeof v.type === "string" &&
    VALID_TYPES.includes(v.type) &&
    (v.confidence === "high" || v.confidence === "low")
  );
}

export async function classifyMessage(
  sender: string,
  text: string
): Promise<Classification> {
  const prompt = `Classify this roommate group-chat message for hearth (a household agent).

Message from ${sender}: "${text}"

${JSON_ONLY}
Schema: {"relevant": boolean, "type": "expense" | "grocery" | "chore" | "action_item" | "query" | "banter" | "maintenance" | "calendar" | "other", "confidence": "high" | "low"}

Guidance:
- "expense": someone paid for something shared, or money owed is discussed
- "grocery": adding/removing/asking about shopping list items
- "chore": assigning, completing, or discussing household tasks
- "action_item": something that needs doing but isn't assigned yet
- "query": a direct question for hearth about household state
- "maintenance": something broken, leaking, not working, or needing repair ("broken", "leaking", "clog", "no hot water", "heat isn't", "AC is", "mold", "crack", "weird smell", "flickering")
- "calendar": a date + event pair (repair windows, guests, travel, package arrivals, lease dates, parties)
- "banter": social chatter not aimed at hearth
- "relevant": false only when hearth clearly has nothing to do or say (pure banter)
- "confidence": "high" only when you're sure`;

  const result = await generateJson<Classification>({
    model: LITE_MODEL,
    systemInstruction: buildUtilitySystemPrompt("the message classifier", serializeState()),
    prompt,
  });

  const classification =
    result !== null && isClassification(result) ? result : FAIL_OPEN;
  log("classifier.result", {
    sender,
    ...classification,
    failedOpen: result === null || !isClassification(result),
  });
  return classification;
}
