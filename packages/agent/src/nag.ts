import { money } from "./state.js";
import {
  getMembers,
  getAllBalances,
  getGroceryItems,
  getLedgerEntries,
  getPendingItems,
  getAllFacts,
  getConfig,
  setConfig,
  getAllMoveEvents,
} from "./db.js";
import { getStalOpenIssues } from "./maintenance.js";
import { getEventsWithin } from "./calendar.js";
import { shouldSuggestDailyReorder, suggestReorder, markSuggestedItems } from "./reorder.js";
import { popDueScheduledNags } from "./scheduled.js";
import { categorySpikeReport, formatSpike } from "./analytics.js";

export interface NagMessage {
  target: string | "group";
  message: string;
  priority: "high" | "low";
  keyboard?: Array<Array<{ text: string; callback_data: string }>>;
}

export async function checkNags(now: Date = new Date()): Promise<NagMessage[]> {
  const spikeNagKey = `last_spending_spike_nag_${now.toISOString().slice(0, 7)}`;
  const [members, balances, openGroceries, ledger, pendingItems, facts, lastRun, moveEventsList, lastSpikeNag] =
    await Promise.all([
      getMembers(),
      getAllBalances(),
      getGroceryItems(true),
      getLedgerEntries(),
      getPendingItems(true),
      getAllFacts(),
      getConfig("last_grocery_run"),
      getAllMoveEvents(),
      getConfig(spikeNagKey),
    ]);

  const nags: NagMessage[] = [];
  const day = now.getDate();

  // ── Rule 1: Rent due ───────────────────────────────────────────────────────
  const nearRent = day <= 3 || day >= 29;
  if (nearRent) {
    const debtors = members.filter((m) => (balances[m] ?? 0) < -0.005);
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

  // ── Rule 2: Stale debt ────────────────────────────────────────────────────
  for (const member of members) {
    const balance = balances[member] ?? 0;
    if (balance >= -0.005) continue;

    const theirDebts = ledger.filter(
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

  // ── Rule 3: Grocery staleness ─────────────────────────────────────────────
  if (openGroceries.length >= 3) {
    const daysSinceRun = lastRun
      ? Math.floor((now.getTime() - Date.parse(lastRun)) / 86_400_000)
      : Infinity;
    if (daysSinceRun >= 4) {
      nags.push({
        target: "group",
        message: `grocery list is getting long (${openGroceries.length} items), want me to compile it?`,
        priority: "low",
      });
    }
  }

  // ── Rule 5: Unresolved action items ───────────────────────────────────────
  for (const item of pendingItems) {
    const ageMs = now.getTime() - Date.parse(item.raisedAt);
    const ageHours = ageMs / 3_600_000;

    if (item.deadline) {
      const msUntil = Date.parse(item.deadline) - now.getTime();
      if (msUntil <= 2 * 3_600_000) {
        const overdue = msUntil < 0;
        nags.push({
          target: "group",
          message: overdue
            ? `heads up — "${item.description}" was supposed to happen by now, anyone on it?`
            : `heads up — still need someone to "${item.description}" (coming up soon)`,
          priority: "high",
        });
      }
    } else if (ageHours >= 6) {
      nags.push({
        target: "group",
        message: `reminder — "${item.description}" (raised by ${item.raisedBy.toLowerCase()}) — anyone picked this up?`,
        priority: "low",
      });
    }
  }

  // ── Rule 6: Maintenance staleness (F1) ───────────────────────────────────
  const nagDays = Number(facts["maintenance_nag_days"] ?? 5);
  const staleIssues = await getStalOpenIssues(nagDays, now);
  for (const issue of staleIssues) {
    const daysOpen = Math.floor(
      (now.getTime() - Date.parse(issue.firstSeenAt)) / 86_400_000
    );
    nags.push({
      target: "group",
      message: `the ${issue.description.toLowerCase()} has been open for ${daysOpen} days — still not sorted? want me to draft something for the landlord?`,
      priority: issue.priority === "urgent" ? "high" : "low",
      keyboard: [[
        { text: "Draft message", callback_data: `maintenance:draft:${issue.id}` },
        { text: "It's resolved", callback_data: `maintenance:resolve:${issue.id}` },
      ]],
    });
  }

  // ── Rule 7: Calendar reminders (F2) ──────────────────────────────────────
  const [in24h, in1h] = await Promise.all([
    getEventsWithin(24, now),
    getEventsWithin(1, now),
  ]);

  const alreadyIn1h = new Set(in1h.map((e) => e.id));

  for (const event of in24h) {
    if (alreadyIn1h.has(event.id)) continue;
    if (event.affectsMembers.length > 0) continue;
    const timeHint = event.eventTime ? ` at ${event.eventTime}` : "";
    nags.push({
      target: "group",
      message: `reminder: ${event.title.toLowerCase()}${timeHint} tomorrow`,
      priority: "low",
    });
  }

  for (const event of in1h) {
    if (event.eventType === "repair") {
      const who =
        event.affectsMembers.length > 0
          ? event.affectsMembers.map((m) => m.toLowerCase()).join(", ")
          : "someone";
      const timeHint = event.eventTime ? ` at ${event.eventTime}` : "";
      nags.push({
        target: event.affectsMembers[0] ?? "group",
        message: `heads up — ${event.title.toLowerCase()}${timeHint} in about an hour. ${who}, you're listed as home for this 🔧`,
        priority: "high",
      });
    } else if (event.eventType === "package") {
      nags.push({
        target: "group",
        message: `package due today, someone should be around 👀`,
        priority: "low",
      });
    }
  }

  // Lease end reminder
  const leaseEnd = facts["lease_end"];
  if (leaseEnd) {
    const daysUntil = Math.floor((Date.parse(leaseEnd) - now.getTime()) / 86_400_000);
    if (daysUntil === 7) {
      nags.push({
        target: "group",
        message: `lease is up in a week — has anyone sorted renewal or move-out?`,
        priority: "high",
      });
    }
  }

  // ── Rule 8: Daily reorder check at 9am (F3) ───────────────────────────────
  if (now.getHours() === 9 && now.getMinutes() < 60) {
    if (await shouldSuggestDailyReorder()) {
      const result = await suggestReorder({ triggered_by: "scheduled" });
      if (result.suggestions.length >= 2) {
        markSuggestedItems(result.suggestions.map((s) => s.itemName));
        nags.push({
          target: "group",
          message: result.message,
          priority: "low",
          keyboard: result.keyboard.length > 0 ? result.keyboard : undefined,
        });
      }
    }
  }

  // ── Rule 10: Scheduled one-off nudges (set_nag) ──────────────────────────
  const due = await popDueScheduledNags(now);
  for (const n of due) {
    nags.push({ target: n.target, message: n.message, priority: n.priority });
  }

  // ── Rule 11: Spending spike alert (Hydra analytics fallback) ─────────────
  if (!lastSpikeNag) {
    const spike = await categorySpikeReport(now);
    if (spike) {
      nags.push({
        target: "group",
        message: `${formatSpike(spike)}. worth checking before it becomes the new normal.`,
        priority: "low",
      });
      await setConfig(spikeNagKey, now.toISOString());
    }
  }

  // ── Rule 9: Move event stall check (F5) ──────────────────────────────────
  for (const move of moveEventsList) {
    if (move.phase === "completed") continue;
    const daysStalled = Math.floor(
      (now.getTime() - Date.parse(move.updatedAt)) / 86_400_000
    );
    if (daysStalled >= 2) {
      nags.push({
        target: "group",
        message: `move-${move.type === "move_out" ? "out" : "in"} for ${move.member.toLowerCase()} is still at "${move.phase.replace("_", " ")}" — any update?`,
        priority: "low",
      });
    }
  }

  return nags;
}
