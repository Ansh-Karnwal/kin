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

export const API = `https://api.telegram.org/bot${TOKEN}`;
const FILE_API = `https://api.telegram.org/file/bot${TOKEN}`;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TgUser {
  id: number;
  is_bot: boolean;
  first_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
}

export interface TgPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  photo?: TgPhotoSize[]; // array; largest is last
  caption?: string;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string; // e.g. "approve:job_abc" or "cancel:job_abc"
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

interface TgResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

interface TgFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

// ── Core call helper ──────────────────────────────────────────────────────────

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

// ── Text messaging ────────────────────────────────────────────────────────────

export function getMe(): Promise<TgUser> {
  return call<TgUser>("getMe", {});
}

export function getUpdates(offset: number, timeoutSec = 30): Promise<TgUpdate[]> {
  return call<TgUpdate[]>("getUpdates", {
    offset,
    timeout: timeoutSec,
    allowed_updates: ["message", "callback_query"],
  });
}

export function sendMessage(
  chatId: number | string,
  text: string,
  parseMode?: "MarkdownV2" | "HTML"
): Promise<TgMessage> {
  return call<TgMessage>("sendMessage", {
    chat_id: chatId,
    text,
    ...(parseMode ? { parse_mode: parseMode } : {}),
  });
}

export function deleteWebhook(): Promise<boolean> {
  return call<boolean>("deleteWebhook", { drop_pending_updates: false });
}

// ── Inline keyboards ──────────────────────────────────────────────────────────

export function sendMessageWithKeyboard(
  chatId: number | string,
  text: string,
  inlineKeyboard: Array<Array<{ text: string; callback_data: string }>>,
  parseMode?: "MarkdownV2" | "HTML"
): Promise<TgMessage> {
  return call<TgMessage>("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: inlineKeyboard },
    ...(parseMode ? { parse_mode: parseMode } : {}),
  });
}

/**
 * Must be called within 3 seconds of receiving a callback_query or Telegram
 * will show a generic error on the button. Answer with "" for a silent ack.
 */
export function answerCallbackQuery(
  callbackQueryId: string,
  text?: string
): Promise<boolean> {
  return call<boolean>("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text !== undefined ? { text } : {}),
  });
}

// ── Photos ────────────────────────────────────────────────────────────────────

/** B1: Send a photo buffer. Wraps it in multipart/form-data. */
export async function sendPhoto(
  chatId: number | string,
  photo: Buffer,
  caption?: string,
  parseMode?: "MarkdownV2" | "HTML"
): Promise<TgMessage> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append(
    "photo",
    new Blob([new Uint8Array(photo)], { type: "image/png" }),
    "screenshot.png"
  );
  if (caption) form.append("caption", caption);
  if (parseMode) form.append("parse_mode", parseMode);

  const res = await fetch(`${API}/sendPhoto`, { method: "POST", body: form });
  const body = (await res.json()) as TgResponse<TgMessage>;
  if (!body.ok) throw new Error(`sendPhoto failed: ${body.description}`);
  return body.result;
}

// ── Documents ─────────────────────────────────────────────────────────────────

/** B2: Send a document (receipts, breakdowns, PDFs). */
export async function sendDocument(
  chatId: number | string,
  document: Buffer,
  filename: string,
  caption?: string,
  parseMode?: "MarkdownV2" | "HTML"
): Promise<TgMessage> {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append(
    "document",
    new Blob([new Uint8Array(document)], { type: "application/octet-stream" }),
    filename
  );
  if (caption) form.append("caption", caption);
  if (parseMode) form.append("parse_mode", parseMode);

  const res = await fetch(`${API}/sendDocument`, { method: "POST", body: form });
  const body = (await res.json()) as TgResponse<TgMessage>;
  if (!body.ok) throw new Error(`sendDocument failed: ${body.description}`);
  return body.result;
}

// ── File download (B5) ────────────────────────────────────────────────────────

/** Resolve a file_id to a downloadable path. */
export function getFile(fileId: string): Promise<TgFile> {
  return call<TgFile>("getFile", { file_id: fileId });
}

/** Download a file from Telegram's CDN and return its Buffer. */
export async function downloadFile(filePath: string): Promise<Buffer> {
  const res = await fetch(`${FILE_API}/${filePath}`);
  if (!res.ok) throw new Error(`file download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Download the largest photo from a TgMessage that contains `photo`.
 * Returns null if the message has no photos or download fails.
 */
export async function downloadLargestPhoto(
  message: TgMessage
): Promise<Buffer | null> {
  if (!message.photo || message.photo.length === 0) return null;
  const largest = message.photo[message.photo.length - 1];
  try {
    const fileInfo = await getFile(largest.file_id);
    if (!fileInfo.file_path) return null;
    return downloadFile(fileInfo.file_path);
  } catch {
    return null;
  }
}

// ── Pin messages ──────────────────────────────────────────────────────────────

/** Pin a message in a group (bot must be admin). Used by move mode. */
export function pinChatMessage(
  chatId: number | string,
  messageId: number
): Promise<boolean> {
  return call<boolean>("pinChatMessage", {
    chat_id: chatId,
    message_id: messageId,
    disable_notification: true,
  });
}

// ── MarkdownV2 escaping ───────────────────────────────────────────────────────

/** Escape a string for Telegram's MarkdownV2 format. */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, (ch) => `\\${ch}`);
}
