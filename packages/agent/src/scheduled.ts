// ── set_nag: scheduled one-off nudges ──────────────────────────────────────────
//
// The rule-based nag engine (nag.ts) derives reminders from state. set_nag lets
// the orchestrator schedule an explicit future nudge ("remind sam about the
// deposit friday"). Stored as a JSON array in household_config so no new table is
// needed; checkNags pops the due ones each hour and fires them once.

import { getConfig, setConfig } from "./db.js";
import { log } from "./log.js";

export interface ScheduledNag {
  id: string;
  target: string; // member name or "group"
  message: string;
  priority: "high" | "low";
  fireAt: string; // ISO timestamp
}

const KEY = "scheduled_nags";

async function load(): Promise<ScheduledNag[]> {
  const raw = await getConfig(KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ScheduledNag[]) : [];
  } catch {
    return [];
  }
}

async function save(nags: ScheduledNag[]): Promise<void> {
  await setConfig(KEY, JSON.stringify(nags));
}

export async function addScheduledNag(input: {
  target: string;
  message: string;
  priority?: "high" | "low";
  fireAt?: string;
}): Promise<ScheduledNag> {
  const nag: ScheduledNag = {
    id: crypto.randomUUID(),
    target: input.target || "group",
    message: input.message,
    priority: input.priority ?? "low",
    // Default: fire on the next hourly check if no time was given.
    fireAt: input.fireAt ?? new Date().toISOString(),
  };
  const all = await load();
  all.push(nag);
  await save(all);
  log("nag.scheduled", { id: nag.id, target: nag.target, fireAt: nag.fireAt });
  return nag;
}

/** Return scheduled nags due at/before `now` and remove them (fire-once). */
export async function popDueScheduledNags(now: Date): Promise<ScheduledNag[]> {
  const all = await load();
  if (all.length === 0) return [];

  const due: ScheduledNag[] = [];
  const remaining: ScheduledNag[] = [];
  for (const n of all) {
    if (Date.parse(n.fireAt) <= now.getTime()) due.push(n);
    else remaining.push(n);
  }

  if (due.length > 0) await save(remaining);
  return due;
}
