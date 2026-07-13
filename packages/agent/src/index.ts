import "./env.js";
import express from "express";
import { classifyMessage } from "./classifier.js";
import { generateText, MAIN_MODEL } from "./gemini.js";
import { buildChatSystemPrompt, findBannedWord } from "./prompts.js";
import { serializeState } from "./state.js";
import { log } from "./log.js";

const PORT = Number(process.env.AGENT_PORT) || 3000;

const FALLBACK_REPLY = "something went wrong on my end, try again?";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "hearth-agent" });
});

interface ChatRequest {
  sender: string;
  text: string;
  chatId: string;
}

function isChatRequest(body: unknown): body is ChatRequest {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.sender === "string" &&
    typeof b.text === "string" &&
    b.text.length > 0 &&
    typeof b.chatId === "string"
  );
}

app.post("/chat", async (req, res) => {
  if (!isChatRequest(req.body)) {
    res.status(400).json({ error: "expected { sender: string, text: string, chatId: string }" });
    return;
  }
  const { sender, text, chatId } = req.body;
  log("chat.inbound", { sender, chatId, text });

  try {
    const classification = await classifyMessage(sender, text);

    // Confidently irrelevant -> stay quiet; the bridge sends nothing for a null reply.
    if (!classification.relevant && classification.confidence === "high") {
      log("chat.skipped", { sender, type: classification.type });
      res.json({ reply: null });
      return;
    }

    const reply = await generateText({
      model: MAIN_MODEL,
      systemInstruction: buildChatSystemPrompt(serializeState()),
      prompt: `${sender}: ${text}`,
    });

    const banned = findBannedWord(reply);
    if (banned) log("chat.tone_violation", { banned, reply });

    log("chat.outbound", { sender, type: classification.type, reply });
    res.json({ reply });
  } catch (err) {
    log("chat.error", { sender, error: String(err) });
    res.json({ reply: FALLBACK_REPLY });
  }
});

app.listen(PORT, () => {
  log("agent.started", { port: PORT, model: MAIN_MODEL });
});
