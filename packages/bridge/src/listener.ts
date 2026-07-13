import fs from "node:fs";
import path from "node:path";
import { BRIDGE_ROOT } from "./env.js";
import { getUpdates, sendMessage, deleteWebhook, type TgMessage } from "./telegram.js";
import { loadHandles, resolveSender } from "./handles.js";
import { log } from "./log.js";

const AGENT_PORT = Number(process.env.AGENT_PORT) || 3000;
const TARGET_CHAT = process.env.TARGET_CHAT_GUID ?? "";

/** Cursor file — survives restarts so we never reprocess Telegram updates. */
const OFFSET_PATH = path.join(BRIDGE_ROOT, ".tg-offset");

function loadOffset(): number {
  try {
    const n = Number(fs.readFileSync(OFFSET_PATH, "utf8").trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function saveOffset(offset: number): void {
  fs.writeFileSync(OFFSET_PATH, `${offset}\n`, "utf8");
}

interface AgentReply {
  reply: string | null;
}

async function forwardToAgent(chatId: string, sender: string, text: string): Promise<void> {
  const res = await fetch(`http://localhost:${AGENT_PORT}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender, text, chatId }),
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
  await sendMessage(chatId, reply);
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

async function handleMessage(message: TgMessage): Promise<void> {
  if (!message.text || !message.from || message.from.is_bot) return;

  const chatId = String(message.chat.id);
  const handles = loadHandles();
  // Telegram gives us the sender's first name for free — use it as the
  // display fallback when this user id hasn't been labeled in handles.json.
  const sender = resolveSender(handles, String(message.from.id), message.from.first_name);

  if (!TARGET_CHAT) {
    log("listener.unconfigured", {
      chatId,
      from: message.from.id,
      name: message.from.first_name,
      text: message.text,
      hint: `set TARGET_CHAT_GUID=${chatId} in .env (or run npm run setup -w packages/bridge)`,
    });
    return;
  }
  if (chatId !== TARGET_CHAT) {
    log("listener.ignored_chat", { chatId });
    return;
  }

  log("listener.inbound", { sender, from: message.from.id, chatId, text: message.text });
  await forwardToAgent(chatId, sender, message.text);
}

let offset = loadOffset();
let running = false;

async function loop(): Promise<void> {
  while (running) {
    let updates;
    try {
      updates = await getUpdates(offset);
    } catch (err) {
      log("listener.poll_error", { error: String(err) });
      await new Promise((r) => setTimeout(r, 3_000));
      continue;
    }
    for (const update of updates) {
      // Advance per update, not per batch — a crash mid-batch must not replay
      // messages the agent already acted on (it mutates balances/grocery state).
      offset = update.update_id + 1;
      saveOffset(offset);
      if (!update.message) continue;
      try {
        await handleMessage(update.message);
      } catch (err) {
        log("listener.handle_failed", { error: String(err) });
      }
    }
  }
}

export async function startListener(): Promise<void> {
  await deleteWebhook(); // long-polling is rejected while a webhook is set
  log("listener.started", {
    chatId: TARGET_CHAT || "(unset — discovery mode, messages logged but not forwarded)",
    offset,
  });
  void seedMembers();
  running = true;
  void loop().catch((err) => log("listener.loop_error", { error: String(err) }));
}

export function stopListener(): void {
  running = false;
}
