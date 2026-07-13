import "./env.js";
import express from "express";
import { classifyMessage } from "./classifier.js";
import { generateText, MAIN_MODEL } from "./gemini.js";
import { buildChatSystemPrompt, findBannedWord } from "./prompts.js";
import { serializeState, state } from "./state.js";
import { log } from "./log.js";
import { checkNags } from "./nag.js";
import { parseExpense, applyExpense, buildExpenseAck } from "./ledger.js";
import {
  parseGroceryIntent,
  applyGroceryIntent,
  matchCompileCommand,
  formatGroceryList,
  doGroceryRun,
} from "./grocery.js";

const PORT = Number(process.env.AGENT_PORT) || 3000;
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT) || 3001;
const TARGET_CHAT = process.env.TARGET_CHAT_GUID ?? "";

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
    res
      .status(400)
      .json({ error: "expected { sender: string, text: string, chatId: string }" });
    return;
  }
  const { sender, text, chatId } = req.body;
  log("chat.inbound", { sender, chatId, text });

  try {
    // Phase 5: compile/run commands are deterministic — skip the model entirely
    const compile = matchCompileCommand(text);
    if (compile) {
      const reply = compile === "run" ? doGroceryRun() : formatGroceryList();
      log("chat.outbound", { sender, type: "grocery", command: compile, reply });
      res.json({ reply });
      return;
    }

    const classification = await classifyMessage(sender, text);

    // Confidently irrelevant → stay quiet; bridge sends nothing for null reply
    if (!classification.relevant && classification.confidence === "high") {
      log("chat.skipped", { sender, type: classification.type });
      res.json({ reply: null });
      return;
    }

    // Phase 4: attempt expense parse before hitting the main model
    if (classification.type === "expense") {
      const expense = await parseExpense(text, sender);
      if (expense) {
        applyExpense(expense);
        const ack = buildExpenseAck(expense);
        log("chat.outbound", { sender, type: "expense", reply: ack });
        res.json({ reply: ack });
        return;
      }
      // Didn't resolve to a concrete expense (e.g. "who owes what?") — fall through to main model
    }

    // Phase 5: grocery list updates
    if (classification.type === "grocery") {
      const intent = await parseGroceryIntent(text, sender);
      if (intent) {
        const reply = applyGroceryIntent(intent);
        log("chat.outbound", { sender, type: "grocery", action: intent.action, reply });
        res.json({ reply });
        return;
      }
      // Couldn't extract a concrete intent — fall through to main model
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

app.get("/balances", (_req, res) => {
  const result = Object.fromEntries(
    state.members.map((m) => [m, state.balances[m] ?? 0])
  );
  res.json(result);
});

app.get("/nag-check", (_req, res) => {
  const nags = checkNags(state);
  log("nag.check", { count: nags.length });
  res.json({ nags });
});

async function dispatchNags(): Promise<void> {
  const nags = checkNags(state);
  if (nags.length === 0) return;

  log("nag.triggered", { count: nags.length });

  const chatId = TARGET_CHAT;
  if (!chatId) {
    log("nag.skipped", { reason: "TARGET_CHAT_GUID not set" });
    return;
  }

  for (const nag of nags) {
    try {
      await fetch(`http://localhost:${BRIDGE_PORT}/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatId, message: nag.message }),
      });
      log("nag.sent", { target: nag.target, priority: nag.priority, message: nag.message });
    } catch (err) {
      log("nag.send_failed", { target: nag.target, error: String(err) });
    }
  }
}

// Run nag check every hour
setInterval(() => {
  dispatchNags().catch((err) =>
    log("nag.scheduler_error", { error: String(err) })
  );
}, 60 * 60 * 1_000);

app.listen(PORT, () => {
  log("agent.started", { port: PORT, model: MAIN_MODEL });
});
