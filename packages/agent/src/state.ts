export interface GroceryItem {
  item: string;
  requestedBy: string;
  addedAt: string;
  fulfilled: boolean; // bought but not yet cleared by a grocery run
}

export interface LedgerEntry {
  payer: string;
  amount: number;
  description: string;
  split: string[];
  timestamp: string;
}

export interface Chore {
  task: string;
  assignee: string;
  dueDate?: string;
  done: boolean;
}

export interface HouseholdState {
  members: string[];
  balances: Record<string, number>; // positive = is owed money
  groceryList: GroceryItem[];
  ledger: LedgerEntry[];
  chores: Chore[];
  householdFacts: Record<string, string>; // e.g. "lease_end" -> "August 2025"
  lastGroceryRun?: string; // ISO timestamp
}

export const state: HouseholdState = {
  members: [],
  balances: {},
  groceryList: [],
  ledger: [],
  chores: [],
  householdFacts: {},
};

export function money(n: number): string {
  const fixed = Math.abs(n).toFixed(2);
  return `$${fixed.endsWith(".00") ? fixed.slice(0, -3) : fixed}`;
}

function describeBalance(member: string, balance: number): string {
  if (balance > 0.005) return `${member} is owed ${money(balance)}`;
  if (balance < -0.005) return `${member} owes ${money(balance)}`;
  return `${member} is settled up`;
}

function daysAgo(iso: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000);
}

/** Serialize the full household state for injection into every Gemini system prompt. */
export function serializeState(s: HouseholdState = state, now: Date = new Date()): string {
  const lines: string[] = ["CURRENT HOUSEHOLD STATE:"];

  lines.push(`Members: ${s.members.length ? s.members.join(", ") : "(none configured yet)"}`);

  const balances = s.members.map((m) => describeBalance(m, s.balances[m] ?? 0));
  lines.push(`Balances: ${balances.length ? balances.join(", ") : "(none)"}`);

  const openGroceries = s.groceryList.filter((g) => !g.fulfilled);
  lines.push(
    `Grocery list: ${
      openGroceries.length
        ? openGroceries.map((g) => `${g.item} (${g.requestedBy})`).join(", ")
        : "(empty)"
    }`
  );
  if (s.lastGroceryRun) {
    lines.push(
      `Last grocery run: ${s.lastGroceryRun.slice(0, 10)} (${daysAgo(s.lastGroceryRun, now)} days ago)`
    );
  }

  const openChores = s.chores.filter((c) => !c.done);
  if (openChores.length) {
    lines.push(
      `Chores: ${openChores
        .map((c) => `${c.task} — ${c.assignee}${c.dueDate ? `, due ${c.dueDate}` : ""}`)
        .join("; ")}`
    );
  }

  const recent = s.ledger.slice(-5);
  if (recent.length) {
    lines.push(
      `Recent expenses: ${recent
        .map(
          (e) =>
            `${e.payer} paid ${money(e.amount)} for ${e.description} (split: ${e.split.join(", ")})`
        )
        .join("; ")}`
    );
  }

  const facts = Object.entries(s.householdFacts);
  if (facts.length) {
    lines.push(`Household facts: ${facts.map(([k, v]) => `${k}: ${v}`).join("; ")}`);
  }

  lines.push(`Today: ${now.toISOString().slice(0, 10)}`);
  return lines.join("\n");
}
