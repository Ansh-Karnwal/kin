import fs from "node:fs";
import path from "node:path";
import type { Message } from "@photon-ai/imessage-kit";
import { sdk } from "./sdk.js";
import { BRIDGE_ROOT } from "./env.js";
import { loadHandles, resolveSender } from "./handles.js";
import { log } from "./log.js";

const AGENT_PORT = Number(process.env.AGENT_PORT) || 3000;
const TARGET_CHAT = process.env.TARGET_CHAT_GUID ?? "";
const POLL_INTERVAL_MS = 2_500;

/** Cursor file — survives restarts so we never reprocess messages. */
const LAST_SEEN_PATH = path.join(BRIDGE_ROOT, ".last-seen");

interface Cursor {
  /** ISO timestamp of the newest processed message — lower bound for queries. */
  lastSeenAt: string;
  /** chat.db rowId of the newest processed message — the actual dedupe key. */
  lastRowId: number;
}

function loadCursor(): Cursor {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(LAST_SEEN_PATH, "utf8"));
    const c = parsed as Partial<Cursor>;
    if (typeof c.lastSeenAt === "string" && typeof c.lastRowId === "number") {
      return { lastSeenAt: c.lastSeenAt, lastRowId: c.lastRowId };
    }
  } catch {
    // Missing or corrupt cursor → start fresh from "now" below.
  }
  return { lastSeenAt: new Date().toISOString(), lastRowId: 0 };
}

function saveCursor(cursor: Cursor): void {
  fs.writeFileSync(LAST_SEEN_PATH, `${JSON.stringify(cursor)}\n`, "utf8");
}

interface AgentReply {
  reply: string | null;
}

/**
 * Echo suppression. Hearth sends through the host account, so its own
 * replies land in chat.db as from-me rows — indistinguishable from the
 * owner typing. Every outbound text is recorded here and matching from-me
 * rows are skipped for a short window, otherwise Hearth would reply to
 * itself in a loop.
 */
const ECHO_WINDOW_MS = 5 * 60 * 1_000;
const recentSends: Array<{ text: string; at: number }> = [];

export function recordSend(text: string): void {
  recentSends.push({ text, at: Date.now() });
}

function isOwnEcho(text: string): boolean {
  const cutoff = Date.now() - ECHO_WINDOW_MS;
  while (recentSends.length > 0 && recentSends[0]!.at < cutoff) recentSends.shift();
  const i = recentSends.findIndex((s) => s.text === text);
  if (i === -1) return false;
  recentSends.splice(i, 1); // each send suppresses exactly one echo
  return true;
}

async function forwardToAgent(message: Message, sender: string): Promise<void> {
  const chatId = message.chatId ?? TARGET_CHAT;
  const res = await fetch(`http://localhost:${AGENT_PORT}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender, text: message.text, chatId }),
  });
  if (!res.ok) {
    log("listener.agent_error", { status: res.status, sender });
    return;
  }
  const { reply } = (await res.json()) as AgentReply;
  if (reply === null || reply === undefined) {
    log("listener.no_reply", { sender });
    return;
  }
  recordSend(reply);
  await sdk.send({ to: chatId, text: reply });
  log("send.outbound", { chatId, message: reply });
}

/**
 * Agent state is in-memory until Phase 7, so member names must be re-seeded
 * on every agent start. Retries while the agent boots under `concurrently`.
 */
async function seedMembers(): Promise<void> {
  const handles = loadHandles();
  const members = [...new Set(Object.values(handles))];
  if (members.length === 0) return;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(`http://localhost:${AGENT_PORT}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ members }),
      });
      if (res.ok) {
        log("listener.members_seeded", { members });
        return;
      }
      log("listener.members_seed_rejected", { status: res.status });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 2_000 * attempt));
    }
  }
  log("listener.members_seed_failed", { reason: "agent unreachable" });
}

let cursor = loadCursor();
let polling = false;
let timer: NodeJS.Timeout | null = null;

async function poll(): Promise<void> {
  // Query is scoped to the household chat and bounded by the cursor timestamp;
  // 1ms overlap is harmless because rowId is the real dedupe key. From-me rows
  // are included (the owner texts from this account) — Hearth's own replies
  // are filtered out by the echo check below.
  const messages = await sdk.getMessages({
    chatId: TARGET_CHAT,
    since: new Date(cursor.lastSeenAt),
    excludeReactions: true,
  });

  const fresh = messages
    .filter((m) => m.rowId > cursor.lastRowId && m.kind === "text" && !!m.text)
    .sort((a, b) => a.rowId - b.rowId);

  if (fresh.length === 0) return;

  const handles = loadHandles();
  for (const message of fresh) {
    // Advance per message, not per batch — a crash mid-batch must not replay
    // messages the agent already acted on (it mutates balances/grocery state).
    cursor = { lastSeenAt: message.createdAt.toISOString(), lastRowId: message.rowId };
    saveCursor(cursor);

    if (message.isFromMe && isOwnEcho(message.text!)) {
      log("listener.echo_skipped", { text: message.text });
      continue;
    }

    const sender = resolveSender(handles, message.participant, message.isFromMe);
    log("listener.inbound", {
      sender,
      participant: message.participant,
      isFromMe: message.isFromMe,
      chatId: message.chatId,
      text: message.text,
    });
    try {
      await forwardToAgent(message, sender);
    } catch (err) {
      log("listener.forward_failed", { sender, error: String(err) });
    }
  }
}

export function startListener(): void {
  if (!TARGET_CHAT) {
    log("listener.disabled", {
      reason: "TARGET_CHAT_GUID not set — run `npm run setup -w packages/bridge`",
    });
    return;
  }
  log("listener.started", {
    chatId: TARGET_CHAT,
    pollIntervalMs: POLL_INTERVAL_MS,
    cursor,
  });
  void seedMembers();
  timer = setInterval(() => {
    if (polling) return; // previous tick still running — skip, don't overlap
    polling = true;
    poll()
      .catch((err) => log("listener.poll_error", { error: String(err) }))
      .finally(() => {
        polling = false;
      });
  }, POLL_INTERVAL_MS);
}

export function stopListener(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
