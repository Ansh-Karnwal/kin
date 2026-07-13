import { generateJson, LITE_MODEL } from "./llm.js";
import { buildUtilitySystemPrompt, JSON_ONLY } from "./prompts.js";
import { buildSerializedState, getMembers, getMemberBalance, adjustBalance, addLedgerEntry } from "./db.js";
import { money } from "./state.js";
import { log } from "./log.js";

export interface Expense {
  payer: string;
  amount: number;
  description: string;
  splitType: "even" | "item-attributed";
  beneficiaries: string[];
  /** Stored receipt image URL, when this expense came from a receipt photo. */
  receiptUrl?: string;
}

function isExpense(value: unknown): value is Expense {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.payer === "string" &&
    typeof v.amount === "number" &&
    v.amount > 0 &&
    typeof v.description === "string" &&
    (v.splitType === "even" || v.splitType === "item-attributed") &&
    Array.isArray(v.beneficiaries) &&
    (v.beneficiaries as unknown[]).every((b) => typeof b === "string") &&
    (v.beneficiaries as string[]).length > 0
  );
}

export async function parseExpense(
  text: string,
  sender: string
): Promise<Expense | null> {
  const stateBlock = await buildSerializedState();
  const prompt = `Does this message describe a shared expense that was paid? Extract it if yes, return null if no.

Message from ${sender}: "${text}"

${JSON_ONLY}
If expense: {"payer": string, "amount": number, "description": string, "splitType": "even" | "item-attributed", "beneficiaries": string[]}
If not an expense (e.g. a question about money, vague mention, or unrelated): null

Rules:
- payer: who paid (typically the sender unless stated otherwise)
- beneficiaries: everyone who shares the cost (include the payer if they're part of the split)
- splitType: "even" for equal splits, "item-attributed" when specific costs go to specific people
- return null if you cannot confidently identify a concrete amount and payer`;

  const result = await generateJson<Expense | null>({
    model: LITE_MODEL,
    systemInstruction: buildUtilitySystemPrompt("the expense parser", stateBlock),
    prompt,
  });

  if (result === null || !isExpense(result)) return null;

  log("ledger.parsed", {
    payer: result.payer,
    amount: result.amount,
    description: result.description,
    beneficiaries: result.beneficiaries,
  });
  return result;
}

export async function applyExpense(expense: Expense): Promise<void> {
  const { payer, amount, beneficiaries } = expense;
  if (beneficiaries.length === 0) return;

  const share = amount / beneficiaries.length;

  // Credit payer, debit each beneficiary
  await adjustBalance(payer, amount);
  await Promise.all(beneficiaries.map((b) => adjustBalance(b, -share)));

  const id = crypto.randomUUID();
  await addLedgerEntry(id, {
    payer,
    amount,
    description: expense.description,
    split: beneficiaries,
    timestamp: new Date().toISOString(),
    receiptUrl: expense.receiptUrl,
  });
}

export async function buildExpenseAck(expense: Expense): Promise<string> {
  const share = expense.amount / expense.beneficiaries.length;
  const debtors = expense.beneficiaries.filter((b) => b !== expense.payer);
  if (debtors.length === 0) return "logged.";

  if (debtors.length === 1) {
    const debtor = debtors[0];
    const running = Math.abs(await getMemberBalance(debtor));
    return `logged. ${debtor.toLowerCase()} owes ${money(share)} — running total: ${debtor.toLowerCase()} owes you ${money(running)}`;
  }

  const parts = debtors.map((d) => `${d.toLowerCase()} owes ${money(share)}`);
  return `logged. ${parts.join(", ")}`;
}
