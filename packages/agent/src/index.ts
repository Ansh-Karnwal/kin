import "./env.js";
import express from "express";
import { classifyMessage } from "./classifier.js";
import { runToolLoop } from "./gemini.js";
import { buildChatSystemPrompt, findBannedWord } from "./prompts.js";
import { serializeState, state } from "./state.js";
import { log } from "./log.js";
import { checkNags } from "./nag.js";
import { toolDeclarations, createDispatch } from "./tools.js";
import { checkResolution, resolveItems, buildResolutionAck } from "./pending.js";
import {
  getActiveJobForChat,
  getOrderJob,
  isApprovalMessage,
  isEditMessage,
  isCancellationMessage,
  extractOtpCode,
  updateOrderJob,
} from "./orders/jobs.js";
import {
  approveAndCheckout,
  cancelOrder,
  editCart,
  submitOtp,
} from "./orders/browser.js";
import { resolveIssue, getIssue, markLandlordNotified } from "./maintenance.js";
import { applyReorderAdd } from "./reorder.js";
import { moveEvents } from "./state.js";
import { utilityBills } from "./state.js";
import { applyExpense } from "./ledger.js";
import { money } from "./state.js";

const PORT = Number(process.env.AGENT_PORT) || 3000;
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT) || 3001;
const TARGET_CHAT = process.env.TARGET_CHAT_GUID ?? "";
const NAG_BRIDGE_PORT = Number(process.env.NAG_BRIDGE_PORT) || BRIDGE_PORT;
const NAG_CHAT_ID = process.env.NAG_CHAT_ID || TARGET_CHAT;

const FALLBACK_REPLY = "something went wrong on my end, try again?";

const app = express();
app.use(express.json({ limit: "10mb" })); // photos may come in as base64

// ── Health ────────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "hearth-agent" });
});

// ── /chat ─────────────────────────────────────────────────────────────────────

interface ChatRequest {
  sender: string;
  text: string;
  chatId: string;
  photoBase64?: string; // B5: photo ingestion from bridge
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
    res.status(400).json({ error: "expected { sender, text, chatId }" });
    return;
  }
  const { sender, text, chatId, photoBase64 } = req.body;
  log("chat.inbound", { sender, chatId, text: text.slice(0, 80) });

  try {
    // ── Pending order intercept ───────────────────────────────────────────────
    // Check for an active order job before anything else — approval/edit/cancel
    // messages must be routed to the job, not the main classifier.
    const activeJob = getActiveJobForChat(chatId);

    if (activeJob?.status === "awaiting_approval") {
      if (isCancellationMessage(text)) {
        await cancelOrder(activeJob.id, BRIDGE_PORT);
        res.json({ reply: null }); // bridge already sends
        return;
      }
      if (isEditMessage(text)) {
        void editCart(activeJob.id, text, BRIDGE_PORT);
        res.json({ reply: "on it — updating the cart" });
        return;
      }
      if (isApprovalMessage(text)) {
        void approveAndCheckout(activeJob.id, sender, BRIDGE_PORT);
        res.json({ reply: "placing the order now 🛒" });
        return;
      }
      // Ambiguous text during approval → re-confirm
      res.json({ reply: "still waiting on the cart approval — say 'yes' to place it, 'cancel' to stop, or tell me what to change" });
      return;
    }

    if (activeJob?.status === "awaiting_otp") {
      const code = extractOtpCode(text);
      if (code) {
        void submitOtp(activeJob.id, code, sender, BRIDGE_PORT);
        res.json({ reply: "got it, submitting the code now..." });
        return;
      }
      // Not a code — pass through to normal handling
    }

    // ── Resolution check ──────────────────────────────────────────────────────
    const resolvedIds = await checkResolution(text, sender);
    if (resolvedIds.length > 0) {
      const resolved = resolveItems(resolvedIds, sender);
      const reply = buildResolutionAck(resolved);
      log("chat.outbound", { sender, type: "resolution", resolved: resolvedIds });
      res.json({ reply });
      return;
    }

    // ── Classifier pre-filter ─────────────────────────────────────────────────
    const classification = await classifyMessage(sender, text);

    if (!classification.relevant && classification.confidence === "high") {
      log("chat.skipped", { sender, type: classification.type });
      res.json({ reply: null });
      return;
    }

    // ── Tool loop ─────────────────────────────────────────────────────────────
    const photoContext = photoBase64
      ? `\n[Note: ${sender} attached a photo to this message]`
      : "";

    const dispatch = createDispatch({ sender, chatId, bridgePort: BRIDGE_PORT });

    const reply = await runToolLoop({
      systemInstruction: buildChatSystemPrompt(serializeState()),
      tools: toolDeclarations,
      message: `${sender}: ${text}${photoContext}`,
      dispatch,
    });

    const banned = findBannedWord(reply);
    if (banned) log("chat.tone_violation", { banned });

    log("chat.outbound", { sender, type: classification.type, reply: reply.slice(0, 120) });

    // If the tool loop sent a keyboard via the bridge and returned empty text, skip
    if (!reply || reply.trim() === "") {
      res.json({ reply: null });
    } else {
      res.json({ reply });
    }
  } catch (err) {
    log("chat.error", { sender, error: String(err) });
    res.json({ reply: FALLBACK_REPLY });
  }
});

// ── /callback (Telegram inline button handler) ────────────────────────────────

interface CallbackRequest {
  queryId: string;
  from: { id: string; name: string };
  data: string;
  chatId: string;
}

function isCallbackRequest(body: unknown): body is CallbackRequest {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    typeof b.queryId === "string" &&
    typeof b.data === "string" &&
    typeof b.chatId === "string"
  );
}

app.post("/callback", async (req, res) => {
  if (!isCallbackRequest(req.body)) {
    res.status(400).json({ error: "expected { queryId, from, data, chatId }" });
    return;
  }

  const { queryId, from, data, chatId } = req.body;
  const sender = from?.name ?? from?.id ?? "unknown";
  log("callback.inbound", { queryId, data, chatId, sender });

  // The bridge already answered the callback query (within 3s deadline).
  // We just process the action and post results via /send.
  res.json({ ok: true });

  const parts = data.split(":");
  const [feature, action, ...rest] = parts;
  const id = rest.join(":"); // rejoin in case id contains colons

  try {
    switch (feature) {
      // ── Order callbacks ───────────────────────────────────────────────────
      case "order": {
        switch (action) {
          case "approve":
            void approveAndCheckout(id, sender, BRIDGE_PORT);
            break;
          case "cancel":
            void cancelOrder(id, BRIDGE_PORT);
            break;
        }
        break;
      }

      // ── Maintenance callbacks ─────────────────────────────────────────────
      case "maintenance": {
        switch (action) {
          case "draft": {
            const { draftLandlordMessage } = await import("./maintenance.js");
            const result = await draftLandlordMessage({ issue_id: id });
            await bridgeSend(chatId, `${result.message}\n\n${result.draft}`);
            if (result.keyboard.length > 0) {
              await bridgeSendKeyboard(chatId, "send it?", result.keyboard);
            }
            break;
          }
          case "resolve":
            bridgeSend(chatId, resolveIssue(id, sender));
            break;
          case "send_landlord": {
            const issue = getIssue(id);
            if (issue && process.env.LANDLORD_MESSAGE_ENABLED === "true") {
              const landlordTg = state.householdFacts["landlord_telegram"];
              if (landlordTg) {
                await bridgeSend(landlordTg, `maintenance request from your tenants:\n\n${issue.description}`);
                markLandlordNotified(id);
                await bridgeSend(chatId, "sent ✓");
              }
            }
            break;
          }
          case "noop":
            break; // "I'll handle it" / "It's fine" — no action needed
        }
        break;
      }

      // ── Reorder callbacks ─────────────────────────────────────────────────
      case "reorder": {
        if (action === "add") {
          const msg = applyReorderAdd(id, "auto-reorder");
          await bridgeSend(chatId, msg);
        }
        // "ignore" → do nothing
        break;
      }

      // ── Utility callbacks ─────────────────────────────────────────────────
      case "utility": {
        switch (action) {
          case "split": {
            const bill = utilityBills.get(id);
            if (!bill) break;
            const members = state.members;
            if (members.length === 0) break;

            // Find the account holder to set as payer
            const { utilityAccounts } = await import("./state.js");
            const account = utilityAccounts.get(bill.accountId);
            const payer = account?.accountHolder ?? "unknown";

            applyExpense({
              payer,
              amount: bill.amount,
              description: `utility bill (${account?.name ?? "utility"})`,
              splitType: "even",
              beneficiaries: members,
            });

            bill.status = "paid";
            const share = bill.amount / members.length;
            await bridgeSend(chatId, `logged — ${money(bill.amount)} split evenly, ${money(share)} each`);
            break;
          }
          case "investigate": {
            await bridgeSend(chatId, "investigating the spike — checking usage history...");
            void investigateUtilitySpike(id, chatId);
            break;
          }
          case "snooze": {
            const bill = utilityBills.get(id);
            if (bill) bill.status = "skipped";
            await bridgeSend(chatId, "ok, snoozed 👍");
            break;
          }
        }
        break;
      }

      // ── Move mode callbacks ───────────────────────────────────────────────
      case "move": {
        const moveEvent = moveEvents.get(id);
        if (!moveEvent) break;

        switch (action) {
          case "keys_returned":
            moveEvent.phase = "completed";
            moveEvent.updatedAt = new Date().toISOString();
            log("move.completed", { id, member: moveEvent.member });
            await bridgeSend(chatId, `done 🏠 ${moveEvent.member.toLowerCase()}'s all squared away. good luck out there.`);
            break;

          case "deposit_full":
            moveEvent.phase = "asset_split";
            moveEvent.updatedAt = new Date().toISOString();
            await bridgeSend(chatId, `got it — full deposit back to ${moveEvent.member.toLowerCase()}. moving to asset split next.`);
            break;

          case "deposit_deduct":
            await bridgeSend(chatId, `ok, list any damage items and amounts. e.g. "cracked mirror $40". say 'done' when finished.`);
            break;

          case "onboard_done":
            moveEvent.phase = "completed";
            moveEvent.updatedAt = new Date().toISOString();
            await bridgeSend(chatId, `all set 🏠 welcome aboard, ${moveEvent.member.toLowerCase()}!`);
            break;

          case "noop":
            break;
        }
        break;
      }
    }
  } catch (err) {
    log("callback.error", { data, error: String(err) });
  }
});

// ── Order management endpoints (for curl testing) ─────────────────────────────

app.post("/order/:jobId/approve", async (req, res) => {
  const job = getOrderJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: "job not found" }); return; }
  void approveAndCheckout(job.id, "api", BRIDGE_PORT);
  res.json({ ok: true, jobId: job.id });
});

app.post("/order/:jobId/cancel", async (req, res) => {
  const job = getOrderJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: "job not found" }); return; }
  void cancelOrder(job.id, BRIDGE_PORT);
  res.json({ ok: true });
});

app.post("/order/:jobId/edit", async (req, res) => {
  const job = getOrderJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: "job not found" }); return; }
  const { instruction } = req.body as { instruction?: string };
  if (!instruction) { res.status(400).json({ error: "instruction required" }); return; }
  void editCart(job.id, instruction, BRIDGE_PORT);
  res.json({ ok: true });
});

app.post("/order/:jobId/otp", async (req, res) => {
  const job = getOrderJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: "job not found" }); return; }
  const { code } = req.body as { code?: string };
  if (!code) { res.status(400).json({ error: "code required" }); return; }
  void submitOtp(job.id, code, "api", BRIDGE_PORT);
  res.json({ ok: true });
});

app.get("/order/:jobId", (req, res) => {
  const job = getOrderJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: "job not found" }); return; }
  res.json(job);
});

// ── State management endpoints ────────────────────────────────────────────────

app.post("/members", (req, res) => {
  const { members } = req.body as { members?: unknown };
  if (!Array.isArray(members) || !members.every((m) => typeof m === "string")) {
    res.status(400).json({ error: "expected { members: string[] }" });
    return;
  }
  state.members = members;
  for (const m of members) {
    if (state.balances[m] === undefined) state.balances[m] = 0;
  }
  log("state.members_set", { members });
  res.json({ ok: true, members: state.members });
});

app.get("/balances", (_req, res) => {
  res.json(Object.fromEntries(state.members.map((m) => [m, state.balances[m] ?? 0])));
});

app.post("/facts", (req, res) => {
  const { key, value } = req.body as { key?: unknown; value?: unknown };
  if (typeof key !== "string" || typeof value !== "string") {
    res.status(400).json({ error: "expected { key: string, value: string }" });
    return;
  }
  state.householdFacts[key] = value;
  log("state.fact_set", { key, value });
  res.json({ ok: true, facts: state.householdFacts });
});

app.delete("/facts/:key", (req, res) => {
  delete state.householdFacts[req.params.key];
  log("state.fact_deleted", { key: req.params.key });
  res.json({ ok: true, facts: state.householdFacts });
});

app.get("/facts", (_req, res) => {
  res.json(state.householdFacts);
});

app.get("/nag-check", (_req, res) => {
  const nags = checkNags(state);
  log("nag.check", { count: nags.length });
  res.json({ nags });
});

// ── Nag dispatch ──────────────────────────────────────────────────────────────

async function bridgeSend(chatId: string, message: string): Promise<void> {
  try {
    await fetch(`http://localhost:${NAG_BRIDGE_PORT}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, message }),
    });
  } catch (err) {
    log("bridge.send_failed", { error: String(err) });
  }
}

async function bridgeSendKeyboard(
  chatId: string,
  message: string,
  keyboard: Array<Array<{ text: string; callback_data: string }>>
): Promise<void> {
  try {
    await fetch(`http://localhost:${NAG_BRIDGE_PORT}/send-keyboard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, message, keyboard }),
    });
  } catch (err) {
    log("bridge.send_keyboard_failed", { error: String(err) });
  }
}

async function dispatchNags(): Promise<void> {
  const nags = checkNags(state);
  if (nags.length === 0) return;
  if (!NAG_CHAT_ID) {
    log("nag.skipped", { reason: "NAG_CHAT_ID not set" });
    return;
  }

  log("nag.triggered", { count: nags.length });

  for (const nag of nags) {
    try {
      if (nag.keyboard && nag.keyboard.length > 0) {
        await bridgeSendKeyboard(NAG_CHAT_ID, nag.message, nag.keyboard);
      } else {
        await bridgeSend(NAG_CHAT_ID, nag.message);
      }
      log("nag.sent", { target: nag.target, priority: nag.priority });
    } catch (err) {
      log("nag.send_failed", { target: nag.target, error: String(err) });
    }
  }
}

// Nag every hour
setInterval(() => {
  dispatchNags().catch((err) => log("nag.scheduler_error", { error: String(err) }));
}, 60 * 60 * 1_000);

// ── Utility spike investigation ───────────────────────────────────────────────

async function investigateUtilitySpike(billId: string, chatId: string): Promise<void> {
  const bill = utilityBills.get(billId);
  if (!bill || !process.env.BROWSERBASE_API_KEY) return;

  const { utilityAccounts: accounts } = await import("./state.js");
  const account = accounts.get(bill.accountId);
  if (!account) return;

  try {
    const { Stagehand } = await import("@browserbasehq/stagehand");
    const { z } = await import("zod");

    const stagehand = new Stagehand({
      env: "BROWSERBASE",
      apiKey: process.env.BROWSERBASE_API_KEY,
      projectId: process.env.BROWSERBASE_PROJECT_ID,
      model: {
        modelName: "gemini-2.5-flash-preview-04-17" as const,
        apiKey: process.env.GEMINI_API_KEY,
      },
      browserbaseSessionCreateParams: {
        projectId: process.env.BROWSERBASE_PROJECT_ID!,
        browserSettings: { context: { id: account.contextId, persist: true } } as Record<string, unknown>,
      },
    });

    await stagehand.init();
    await stagehand.act(`navigate to ${account.loginUrl}`);

    // Use agent primitive for multi-step portal navigation
    await stagehand.agent().execute(
      "navigate to the usage history or detailed breakdown for the current billing period. find the day-by-day or appliance usage data."
    );

    const UsageSchema = z.object({
      summary: z.string().describe("plain-language explanation of the usage pattern"),
      peakDays: z.array(z.string()).optional(),
    });

    const extracted = await stagehand.extract(
      "extract a summary of the usage breakdown and identify which days or appliances used the most energy",
      UsageSchema
    );

    await stagehand.close();

    await bridgeSend(chatId, `looks like: ${extracted.summary.toLowerCase()}`);
  } catch (err) {
    log("utility.investigate_failed", { billId, error: String(err) });
    await bridgeSend(chatId, "couldn't pull the usage data — portal may need a fresh login");
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  log("agent.started", { port: PORT });
});
