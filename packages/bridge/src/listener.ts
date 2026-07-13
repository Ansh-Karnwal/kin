import fs from "node:fs";
import path from "node:path";
import { BRIDGE_ROOT } from "./env.js";
import {
  getUpdates,
  sendMessage,
  answerCallbackQuery,
  removeInlineKeyboard,
  downloadLargestPhoto,
  type TgMessage,
  type TgCallbackQuery,
} from "./telegram.js";
import { loadHandles, resolveSender } from "./handles.js";
import { log } from "./log.js";

const AGENT_PORT = Number(process.env.AGENT_PORT) || 3000;
const TARGET_CHAT = process.env.TARGET_CHAT_GUID ?? "";

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

// ── Agent forwarding ──────────────────────────────────────────────────────────

interface AgentReply {
  reply: string | null;
}

async function forwardToAgent(
  chatId: string,
  sender: string,
  text: string,
  photoBase64?: string
): Promise<void> {
  const res = await fetch(`http://localhost:${AGENT_PORT}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender, text, chatId, photoBase64 }),
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
  log("send.outbound", { chatId, message: reply.slice(0, 80) });
}

/**
 * Forward a Telegram callback_query to the agent's /callback endpoint.
 * The bridge answers the query immediately (3s deadline); the agent handles async.
 */
async function forwardCallback(
  chatId: string,
  sender: string,
  queryId: string,
  data: string,
  from: { id: number; first_name?: string }
): Promise<void> {
  await fetch(`http://localhost:${AGENT_PORT}/callback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      queryId,
      from: { id: String(from.id), name: sender },
      data,
      chatId,
    }),
  });
}

// ── Member seeding ────────────────────────────────────────────────────────────

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

// ── Message handler ───────────────────────────────────────────────────────────

async function handleMessage(message: TgMessage): Promise<void> {
  if (!message.from || message.from.is_bot) return;

  // Require either text or a photo — ignore other update types (stickers, etc.)
  const hasText = !!message.text;
  const hasPhoto = !!(message.photo && message.photo.length > 0);
  if (!hasText && !hasPhoto) return;

  const chatId = String(message.chat.id);
  const handles = loadHandles();
  const sender = resolveSender(handles, String(message.from.id), message.from.first_name);

  if (!TARGET_CHAT) {
    log("listener.unconfigured", {
      chatId,
      from: message.from.id,
      name: message.from.first_name,
      text: message.text ?? "(photo)",
      hint: `set TARGET_CHAT_GUID=${chatId} in .env`,
    });
    return;
  }
  if (chatId !== TARGET_CHAT) {
    log("listener.ignored_chat", { chatId });
    return;
  }

  // B5: photo ingestion — download the largest photo and pass as base64
  let photoBase64: string | undefined;
  if (hasPhoto) {
    try {
      const buf = await downloadLargestPhoto(message);
      if (buf) {
        photoBase64 = buf.toString("base64");
        log("listener.photo_downloaded", { sender, bytes: buf.length });
      }
    } catch (err) {
      log("listener.photo_download_failed", { error: String(err) });
    }
  }

  // Use caption as text for photo messages (or a placeholder if no caption)
  const text = message.text ?? message.caption ?? "(photo attached)";

  log("listener.inbound", { sender, from: message.from.id, chatId, text: text.slice(0, 80) });
  await forwardToAgent(chatId, sender, text, photoBase64);
}

// ── Callback handler (B3) ─────────────────────────────────────────────────────

async function handleCallbackQuery(query: TgCallbackQuery): Promise<void> {
  const { id: queryId, from, message, data } = query;

  // Answer immediately — Telegram shows a spinner for ~3s without this
  try {
    await answerCallbackQuery(queryId, "");
  } catch (err) {
    log("listener.answer_callback_failed", { queryId, error: String(err) });
  }

  if (!data || !message) return;

  const chatId = String(message.chat.id);

  if (!TARGET_CHAT || chatId !== TARGET_CHAT) {
    log("listener.callback_ignored", { chatId });
    return;
  }

  const handles = loadHandles();
  const sender = resolveSender(handles, String(from.id), from.first_name);

  // One-shot buttons: strip the keyboard on first press so approve/cancel
  // can't both fire on the same cart.
  try {
    await removeInlineKeyboard(chatId, message.message_id);
  } catch (err) {
    log("listener.remove_keyboard_failed", { chatId, error: String(err) });
  }

  log("listener.callback", { sender, chatId, data });
  await forwardCallback(chatId, sender, queryId, data, from);
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

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
      // Advance offset per update (not per batch) to prevent replay on crash
      offset = update.update_id + 1;
      saveOffset(offset);

      try {
        if (update.callback_query) {
          await handleCallbackQuery(update.callback_query);
        } else if (update.message) {
          await handleMessage(update.message);
        }
      } catch (err) {
        log("listener.handle_failed", { error: String(err) });
      }
    }
  }
}

export async function startListener(): Promise<void> {
  await (await import("./telegram.js")).deleteWebhook();
  log("listener.started", {
    chatId: TARGET_CHAT || "(unset — discovery mode)",
    offset,
  });
  void seedMembers();
  running = true;
  void loop().catch((err) => log("listener.loop_error", { error: String(err) }));
}

export function stopListener(): void {
  running = false;
}
