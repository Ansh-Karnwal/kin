import {
  maintenanceIssues,
  state,
  type MaintenanceIssue,
  type MaintenancePriority,
} from "./state.js";
import { generateText, MAIN_MODEL } from "./gemini.js";
import { buildChatSystemPrompt, findBannedWord } from "./prompts.js";
import { serializeState } from "./state.js";
import { log } from "./log.js";

// ── Tool handlers ─────────────────────────────────────────────────────────────

interface LogMaintenanceArgs {
  description: string;
  reported_by: string;
  priority: MaintenancePriority;
  photo_url?: string;
}

/** Insert a new maintenance issue. Returns the keyboard-ready response. */
export function logMaintenanceIssue(args: LogMaintenanceArgs): {
  issueId: string;
  message: string;
  keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  const id = `maint_${Date.now()}`;
  const now = new Date().toISOString();

  // Deduplicate: check for a very similar open issue
  const existing = findSimilarIssue(args.description);
  if (existing) {
    existing.lastUpdatedAt = now;
    if (args.photo_url) existing.photoUrls.push(args.photo_url);
    log("maintenance.deduped", { existingId: existing.id, description: args.description });
    return {
      issueId: existing.id,
      message: `already tracking that — same issue logged (${existing.id.slice(-6)})`,
      keyboard: buildMaintenanceKeyboard(existing.id),
    };
  }

  const issue: MaintenanceIssue = {
    id,
    description: args.description,
    reportedBy: args.reported_by,
    status: "open",
    priority: args.priority,
    firstSeenAt: now,
    lastUpdatedAt: now,
    photoUrls: args.photo_url ? [args.photo_url] : [],
  };

  maintenanceIssues.set(id, issue);
  log("maintenance.logged", { id, description: args.description, priority: args.priority, reportedBy: args.reported_by });

  const priorityEmoji = { low: "🔧", medium: "🔧", urgent: "🚨" }[args.priority];
  const ack = `logged ${priorityEmoji} ${args.description.toLowerCase()} — i'll flag it if it's not sorted in a few days. want me to draft something for the landlord now?`;

  return {
    issueId: id,
    message: ack,
    keyboard: buildMaintenanceKeyboard(id),
  };
}

function buildMaintenanceKeyboard(
  issueId: string
): Array<Array<{ text: string; callback_data: string }>> {
  return [[
    { text: "Draft message", callback_data: `maintenance:draft:${issueId}` },
    { text: "I'll handle it", callback_data: `maintenance:noop:${issueId}` },
    { text: "It's fine", callback_data: `maintenance:noop:${issueId}` },
  ]];
}

/** Loose similarity check: does the description share key words with an open issue? */
function findSimilarIssue(description: string): MaintenanceIssue | undefined {
  const words = description.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  for (const issue of maintenanceIssues.values()) {
    if (issue.status === "resolved") continue;
    const issueWords = issue.description.toLowerCase();
    const matches = words.filter((w) => issueWords.includes(w));
    if (matches.length >= 2) return issue;
  }
  return undefined;
}

// ── Draft landlord message ────────────────────────────────────────────────────

interface DraftLandlordArgs {
  issue_id: string;
}

export async function draftLandlordMessage(
  args: DraftLandlordArgs
): Promise<{ message: string; draft: string; keyboard: Array<Array<{ text: string; callback_data: string }>> }> {
  const issue = maintenanceIssues.get(args.issue_id);
  if (!issue) {
    return { message: "couldn't find that issue", draft: "", keyboard: [] };
  }

  const facts = state.householdFacts;
  const landlordName = facts["landlord_name"] ?? "Landlord";
  const unit = facts["unit_number"] ?? "";
  const address = facts["property_address"] ?? "";
  const leaseRef = facts["lease_reference"] ?? "";

  // Prior reports of the same issue
  const priorReports = [...maintenanceIssues.values()].filter(
    (i) =>
      i.id !== issue.id &&
      i.description.toLowerCase().split(/\W+/).some((w) =>
        issue.description.toLowerCase().includes(w) && w.length > 3
      )
  );

  const priorContext =
    priorReports.length > 0
      ? `\n\nNote: this issue was previously reported on ${priorReports
          .map((p) => p.firstSeenAt.slice(0, 10))
          .join(", ")}. This is a recurring problem.`
      : "";

  const prompt = `Draft a professional, firm but polite maintenance request message to the landlord.

Issue: ${issue.description}
Priority: ${issue.priority}
First reported: ${issue.firstSeenAt.slice(0, 10)}
Reported by: ${issue.reportedBy}
${unit ? `Unit: ${unit}` : ""}
${address ? `Address: ${address}` : ""}
${leaseRef ? `Lease ref: ${leaseRef}` : ""}
${priorContext}

Landlord name: ${landlordName}

Write a concise message (3-5 sentences) requesting timely repair. Professional, not aggressive. No fluff.`;

  let draft = await generateText({
    model: MAIN_MODEL,
    systemInstruction: buildChatSystemPrompt(serializeState()),
    prompt,
  });

  // Tone check
  const banned = findBannedWord(draft);
  if (banned) log("maintenance.draft_tone_violation", { banned });

  // Prefix and suffix to clearly mark it as a draft
  const landlordTelegram = facts["landlord_telegram"];
  const canSend = !!landlordTelegram && process.env.LANDLORD_MESSAGE_ENABLED === "true";

  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [[
    ...(canSend ? [{ text: "Send to landlord", callback_data: `maintenance:send_landlord:${issue.id}` }] : []),
    { text: "Edit", callback_data: `maintenance:noop:${issue.id}` },
    { text: "Cancel", callback_data: `maintenance:noop:${issue.id}` },
  ]];

  const sendNote = canSend
    ? "tap 'send' to DM your landlord on Telegram"
    : "copy and send this to your landlord";

  log("maintenance.draft_created", { issueId: issue.id, canSend });

  return {
    message: `draft ready (${sendNote}):`,
    draft,
    keyboard,
  };
}

// ── Status updates ────────────────────────────────────────────────────────────

export function resolveIssue(issueId: string, resolvedBy: string): string {
  const issue = maintenanceIssues.get(issueId);
  if (!issue) return "issue not found";
  issue.status = "resolved";
  issue.resolutionNotes = `marked resolved by ${resolvedBy}`;
  issue.lastUpdatedAt = new Date().toISOString();
  log("maintenance.resolved", { issueId, resolvedBy });
  return `got it — "${issue.description}" marked resolved ✓`;
}

export function markLandlordNotified(issueId: string): void {
  const issue = maintenanceIssues.get(issueId);
  if (!issue) return;
  issue.status = "landlord_notified";
  issue.landlordNotifiedAt = new Date().toISOString();
  issue.lastUpdatedAt = new Date().toISOString();
}

/** Returns all open issues older than N days. Used by the nag engine. */
export function getStalOpenIssues(olderThanDays: number, now: Date = new Date()): MaintenanceIssue[] {
  const cutoff = olderThanDays * 86_400_000;
  return [...maintenanceIssues.values()].filter(
    (i) =>
      i.status === "open" &&
      now.getTime() - Date.parse(i.firstSeenAt) > cutoff
  );
}

export function getIssue(id: string): MaintenanceIssue | undefined {
  return maintenanceIssues.get(id);
}

export function getAllOpenIssues(): MaintenanceIssue[] {
  return [...maintenanceIssues.values()].filter((i) => i.status !== "resolved");
}
