import {
  getMaintenanceIssues,
  getMaintenanceIssue,
  addMaintenanceIssue,
  patchMaintenanceIssue,
  getAllFacts,
  buildSerializedState,
} from "./db.js";
import type { MaintenanceIssue, MaintenancePriority } from "./state.js";
import { generateText, MAIN_MODEL } from "./llm.js";
import { buildChatSystemPrompt, findBannedWord } from "./prompts.js";
import { log } from "./log.js";

// ── Tool handlers ─────────────────────────────────────────────────────────────

interface LogMaintenanceArgs {
  description: string;
  reported_by: string;
  priority: MaintenancePriority;
  photo_url?: string;
}

/** Insert a new maintenance issue. Returns the keyboard-ready response. */
export async function logMaintenanceIssue(args: LogMaintenanceArgs): Promise<{
  issueId: string;
  message: string;
  keyboard: Array<Array<{ text: string; callback_data: string }>>;
}> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // Deduplicate: check for a very similar open issue
  const existing = await findSimilarIssue(args.description);
  if (existing) {
    const photoUrls = args.photo_url
      ? [...existing.photoUrls, args.photo_url]
      : existing.photoUrls;
    await patchMaintenanceIssue(existing.id, {
      lastUpdatedAt: now,
      photoUrls,
    });
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

  await addMaintenanceIssue(issue);
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
async function findSimilarIssue(description: string): Promise<MaintenanceIssue | undefined> {
  const words = description.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  const openIssues = await getMaintenanceIssues();
  for (const issue of openIssues) {
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
  const issue = await getMaintenanceIssue(args.issue_id);
  if (!issue) {
    return { message: "couldn't find that issue", draft: "", keyboard: [] };
  }

  const facts = await getAllFacts();
  const landlordName = facts["landlord_name"] ?? "Landlord";
  const unit = facts["unit_number"] ?? "";
  const address = facts["property_address"] ?? "";
  const leaseRef = facts["lease_reference"] ?? "";

  // Prior reports of the same issue
  const allIssues = await getMaintenanceIssues();
  const priorReports = allIssues.filter(
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

  const stateBlock = await buildSerializedState();
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

  const draft = await generateText({
    model: MAIN_MODEL,
    systemInstruction: buildChatSystemPrompt(stateBlock),
    prompt,
  });

  const banned = findBannedWord(draft);
  if (banned) log("maintenance.draft_tone_violation", { banned });

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

  return { message: `draft ready (${sendNote}):`, draft, keyboard };
}

// ── Status updates ────────────────────────────────────────────────────────────

export async function resolveIssue(issueId: string, resolvedBy: string): Promise<string> {
  const issue = await getMaintenanceIssue(issueId);
  if (!issue) return "issue not found";
  await patchMaintenanceIssue(issueId, {
    status: "resolved",
    resolutionNotes: `marked resolved by ${resolvedBy}`,
    lastUpdatedAt: new Date().toISOString(),
  });
  log("maintenance.resolved", { issueId, resolvedBy });
  return `got it — "${issue.description}" marked resolved ✓`;
}

export async function markLandlordNotified(issueId: string): Promise<void> {
  const now = new Date().toISOString();
  await patchMaintenanceIssue(issueId, {
    status: "landlord_notified",
    landlordNotifiedAt: now,
    lastUpdatedAt: now,
  });
}

/** Returns all open issues older than N days. Used by the nag engine. */
export async function getStalOpenIssues(
  olderThanDays: number,
  now: Date = new Date()
): Promise<MaintenanceIssue[]> {
  const cutoff = olderThanDays * 86_400_000;
  const openIssues = await getMaintenanceIssues("open");
  return openIssues.filter(
    (i) => now.getTime() - Date.parse(i.firstSeenAt) > cutoff
  );
}

export { getMaintenanceIssue as getIssue };

export async function getAllOpenIssues(): Promise<MaintenanceIssue[]> {
  const all = await getMaintenanceIssues();
  return all.filter((i) => i.status !== "resolved");
}
