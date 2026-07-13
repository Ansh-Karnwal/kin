import express from "express";
import type { Server } from "node:http";
import { text } from "@photon-ai/slack";
import { getTeam, isConfigured } from "./client.js";
import { log } from "./log.js";

const PORT = Number(process.env.SLACK_BRIDGE_PORT) || 3002;

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
    res.json({ status: "ok", service: "hearth-slack-bridge", configured: isConfigured() });
  });

  // Same contract as the iMessage bridge: chatId is the Slack channel id.
  app.post("/send", async (req, res) => {
    if (!isSendBody(req.body)) {
      res.status(400).json({ error: "expected { chatId: string, message: string }" });
      return;
    }
    const { chatId, message } = req.body;
    try {
      await getTeam().messages.send({ channel: chatId, ...text(message) });
      log("send.outbound", { channel: chatId, message });
      res.json({ ok: true });
    } catch (err) {
      log("send.failed", { channel: chatId, error: String(err) });
      res.status(502).json({ ok: false, error: String(err) });
    }
  });

  return app.listen(PORT, () => {
    log("sender.started", { port: PORT });
  });
}
