import { generateJson, LITE_MODEL } from "./gemini.js";
import { JSON_ONLY, buildUtilitySystemPrompt } from "./prompts.js";
import { serializeState } from "./state.js";
import { log } from "./log.js";

export type MessageType = "expense" | "grocery" | "chore" | "query" | "banter" | "other";

export interface Classification {
  relevant: boolean;
  type: MessageType;
  confidence: "high" | "low";
}

/** Fail-open default when the classifier errors or returns junk. */
const FAIL_OPEN: Classification = { relevant: true, type: "other", confidence: "low" };

const VALID_TYPES: readonly string[] = ["expense", "grocery", "chore", "query", "banter", "other"];

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

export async function classifyMessage(sender: string, text: string): Promise<Classification> {
  const prompt = `Classify this roommate group-chat message for hearth (a household agent that tracks shared expenses, the grocery list, and chores).

Message from ${sender}: "${text}"

${JSON_ONLY}
Schema: {"relevant": boolean, "type": "expense" | "grocery" | "chore" | "query" | "banter" | "other", "confidence": "high" | "low"}

Guidance:
- "expense": someone paid for something shared, or money owed is being discussed ("venmo me", "i got the pizza, $42")
- "grocery": adding/removing/asking about shopping list items ("we're out of oat milk", "got the paper towels")
- "chore": assigning, completing, or discussing household tasks ("can someone take out the trash by friday")
- "query": a direct question for hearth about household state ("who owes what?", "what's on the list?")
- "banter": social chatter not aimed at hearth
- "relevant": false only when hearth clearly has nothing to do or say here (pure banter between humans)
- "confidence": "high" only when you're sure`;

  const result = await generateJson<Classification>({
    model: LITE_MODEL,
    systemInstruction: buildUtilitySystemPrompt("the message classifier", serializeState()),
    prompt,
  });

  const classification = result !== null && isClassification(result) ? result : FAIL_OPEN;
  log("classifier.result", { sender, ...classification, failedOpen: result === null || !isClassification(result) });
  return classification;
}
