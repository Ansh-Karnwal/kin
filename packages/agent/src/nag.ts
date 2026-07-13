import { HouseholdState, money } from "./state.js";

export interface NagMessage {
  target: string | "group";
  message: string;
  priority: "high" | "low";
}

export function checkNags(s: HouseholdState, now: Date = new Date()): NagMessage[] {
  const nags: NagMessage[] = [];
  const day = now.getDate();

  // Rule 1: Rent due — within 3 days of the 1st (days 29–31 or 1–3)
  const nearRent = day <= 3 || day >= 29;
  if (nearRent) {
    const debtors = s.members.filter((m) => (s.balances[m] ?? 0) < -0.005);
    if (debtors.length > 0) {
      const prefix =
        day >= 29
          ? `rent's due in ${32 - day} day${32 - day !== 1 ? "s" : ""}`
          : "rent's due";
      const names = debtors.map((m) => m.toLowerCase()).join(" and ");
      nags.push({
        target: "group",
        message: `${prefix} — ${names} ${debtors.length === 1 ? "hasn't" : "haven't"} squared up yet`,
        priority: "high",
      });
    }
  }

  // Rule 2: Stale debt — balance outstanding 5+ days, based on oldest ledger entry
  for (const member of s.members) {
    const balance = s.balances[member] ?? 0;
    if (balance >= -0.005) continue;

    const theirDebts = s.ledger.filter(
      (e) => e.split.includes(member) && e.payer !== member
    );
    if (theirDebts.length === 0) continue;

    const oldest = theirDebts.reduce((a, b) =>
      Date.parse(a.timestamp) < Date.parse(b.timestamp) ? a : b
    );
    const daysOld = Math.floor(
      (now.getTime() - Date.parse(oldest.timestamp)) / 86_400_000
    );

    if (daysOld >= 5) {
      nags.push({
        target: member,
        message: `hey ${member.toLowerCase()}, you've owed ${money(Math.abs(balance))} for ${daysOld} days 👀`,
        priority: "low",
      });
    }
  }

  // Rule 3: Grocery staleness — 3+ open items and last run 4+ days ago (or never)
  const openGroceries = s.groceryList.filter((g) => !g.fulfilled);
  if (openGroceries.length >= 3) {
    const daysSinceRun = s.lastGroceryRun
      ? Math.floor((now.getTime() - Date.parse(s.lastGroceryRun)) / 86_400_000)
      : Infinity;
    if (daysSinceRun >= 4) {
      nags.push({
        target: "group",
        message: `grocery list is getting long (${openGroceries.length} items), want me to compile it?`,
        priority: "low",
      });
    }
  }

  // Rule 4: Overdue chore — dueDate passed and not marked done
  for (const chore of s.chores) {
    if (chore.done || !chore.dueDate) continue;
    const due = Date.parse(chore.dueDate);
    if (!isNaN(due) && due < now.getTime()) {
      nags.push({
        target: chore.assignee,
        message: `hey ${chore.assignee.toLowerCase()}, "${chore.task}" was due ${chore.dueDate} — still on it?`,
        priority: "low",
      });
    }
  }

  return nags;
}
