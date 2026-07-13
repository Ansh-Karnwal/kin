import "./env.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";

if (!TOKEN) {
  console.error(
    [
      "TELEGRAM_BOT_TOKEN missing from .env.",
      "in Telegram, message @BotFather → /newbot → paste the token it gives",
      "you into .env as TELEGRAM_BOT_TOKEN, then restart.",
    ].join("\n")
  );
  process.exit(1);
}

const API = `https://api.telegram.org/bot${TOKEN}`;

/** A Telegram user (sender). */
export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name?: string;
  username?: string;
}

/** The chat a message belongs to. Group ids are negative. */
export interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
}

interface TgResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const body = (await res.json()) as TgResponse<T>;
  if (!body.ok) {
    throw new Error(`telegram ${method} failed: ${body.description ?? res.status}`);
  }
  return body.result;
}

/** Identity of the bot — used to confirm the token at startup. */
export function getMe(): Promise<TgUser> {
  return call<TgUser>("getMe", {});
}

/**
 * Long-poll for new updates. `offset` should be the last seen update_id + 1,
 * which also acknowledges everything before it. `timeoutSec` holds the
 * connection open server-side until an update arrives (or the timeout).
 */
export function getUpdates(offset: number, timeoutSec = 30): Promise<TgUpdate[]> {
  return call<TgUpdate[]>("getUpdates", {
    offset,
    timeout: timeoutSec,
    allowed_updates: ["message"],
  });
}

/** Send a text message to a chat (works for both DMs and group chats). */
export function sendMessage(chatId: string, text: string): Promise<TgMessage> {
  return call<TgMessage>("sendMessage", { chat_id: chatId, text });
}

/** Remove any registered webhook so getUpdates (long-polling) is allowed. */
export function deleteWebhook(): Promise<boolean> {
  return call<boolean>("deleteWebhook", { drop_pending_updates: false });
}
