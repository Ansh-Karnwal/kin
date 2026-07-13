import express from "express";
import type { Server } from "node:http";
import { sdk } from "./sdk.js";
import { recordSend } from "./listener.js";
import { log } from "./log.js";

const PORT = Number(process.env.BRIDGE_PORT) || 3001;

interface SendBody {
  chatId: string;
  message: string;
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

export function startSender(): Server {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "hearth-bridge" });
  });

  app.post("/send", async (req, res) => {
    if (!isSendBody(req.body)) {
      res.status(400).json({ error: "expected { chatId: string, message: string }" });
      return;
    }
    const { chatId, message } = req.body;
    try {
      recordSend(message);
      await sdk.send({ to: chatId, text: message });
      log("send.outbound", { chatId, message });
      res.json({ ok: true });
    } catch (err) {
      log("send.failed", { chatId, error: String(err) });
      res.status(502).json({ ok: false, error: String(err) });
    }
  });

  return app.listen(PORT, () => {
    log("sender.started", { port: PORT });
  });
}
