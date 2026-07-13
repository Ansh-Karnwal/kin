import express from "express";
import type { Server } from "node:http";
import { sendMessage, sendPhoto, sendDocument, sendMessageWithKeyboard } from "./telegram.js";
import { log } from "./log.js";

const PORT = Number(process.env.BRIDGE_PORT) || 3001;

// ── Request shape guards ──────────────────────────────────────────────────────

interface SendBody {
  chatId: string;
  message: string;
}

interface SendPhotoBody {
  chatId: string;
  photo: string; // base64-encoded PNG
  caption?: string;
}

interface SendDocumentBody {
  chatId: string;
  document: string; // base64-encoded
  filename: string;
  caption?: string;
}

interface SendKeyboardBody {
  chatId: string;
  message: string;
  keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

function isSendBody(body: unknown): body is SendBody {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.chatId === "string" &&
    b.chatId.length > 0 &&
    typeof b.message === "string" &&
    b.message.length > 0
  );
}

function isSendPhotoBody(body: unknown): body is SendPhotoBody {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return typeof b.chatId === "string" && typeof b.photo === "string";
}

function isSendDocumentBody(body: unknown): body is SendDocumentBody {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.chatId === "string" &&
    typeof b.document === "string" &&
    typeof b.filename === "string"
  );
}

function isSendKeyboardBody(body: unknown): body is SendKeyboardBody {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.chatId === "string" &&
    typeof b.message === "string" &&
    Array.isArray(b.keyboard)
  );
}

// ── Server ────────────────────────────────────────────────────────────────────

export function startSender(): Server {
  const app = express();
  app.use(express.json({ limit: "20mb" })); // base64 photos can be large

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "hearth-bridge" });
  });

  // B1 text messages
  app.post("/send", async (req, res) => {
    if (!isSendBody(req.body)) {
      res.status(400).json({ error: "expected { chatId: string, message: string }" });
      return;
    }
    const { chatId, message } = req.body;
    try {
      await sendMessage(chatId, message);
      log("send.outbound", { chatId, message: message.slice(0, 80) });
      res.json({ ok: true });
    } catch (err) {
      log("send.failed", { chatId, error: String(err) });
      res.status(502).json({ ok: false, error: String(err) });
    }
  });

  // B1 photo messages (base64-encoded PNG body)
  app.post("/send-photo", async (req, res) => {
    if (!isSendPhotoBody(req.body)) {
      res.status(400).json({ error: "expected { chatId, photo (base64), caption? }" });
      return;
    }
    const { chatId, photo, caption } = req.body;
    try {
      const buf = Buffer.from(photo, "base64");
      await sendPhoto(chatId, buf, caption);
      log("send.photo", { chatId, caption: caption?.slice(0, 60) });
      res.json({ ok: true });
    } catch (err) {
      log("send.photo_failed", { chatId, error: String(err) });
      res.status(502).json({ ok: false, error: String(err) });
    }
  });

  // B2 document messages
  app.post("/send-document", async (req, res) => {
    if (!isSendDocumentBody(req.body)) {
      res.status(400).json({ error: "expected { chatId, document (base64), filename, caption? }" });
      return;
    }
    const { chatId, document, filename, caption } = req.body;
    try {
      const buf = Buffer.from(document, "base64");
      await sendDocument(chatId, buf, filename, caption);
      log("send.document", { chatId, filename });
      res.json({ ok: true });
    } catch (err) {
      log("send.document_failed", { chatId, error: String(err) });
      res.status(502).json({ ok: false, error: String(err) });
    }
  });

  // B3 inline keyboard messages
  app.post("/send-keyboard", async (req, res) => {
    if (!isSendKeyboardBody(req.body)) {
      res.status(400).json({ error: "expected { chatId, message, keyboard }" });
      return;
    }
    const { chatId, message, keyboard } = req.body;
    try {
      await sendMessageWithKeyboard(chatId, message, keyboard);
      log("send.keyboard", { chatId, message: message.slice(0, 80), buttons: keyboard.flat().length });
      res.json({ ok: true });
    } catch (err) {
      log("send.keyboard_failed", { chatId, error: String(err) });
      res.status(502).json({ ok: false, error: String(err) });
    }
  });

  return app.listen(PORT, () => {
    log("sender.started", { port: PORT });
  });
}
