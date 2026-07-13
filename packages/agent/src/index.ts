import "./env.js";
import express from "express";
import { classifyMessage } from "./classifier.js";
import { runToolLoop } from "./llm.js";
import { buildChatSystemPrompt, findBannedWord } from "./prompts.js";
import { buildSerializedState, getMembers, setMembers, getAllFacts, setFact, deleteFact, getMoveEvent, patchMoveEvent, getUtilityBill, getUtilityAccount, getAllUtilityAccounts, getAllBalances, patchUtilityBill } from "./db.js";
import { money } from "./state.js";
import { log } from "./log.js";
import { checkNags } from "./nag.js";
import { toolDeclarations, createDispatch } from "./tools.js";
import { getPriceTrend, type PriceTrend } from "./nimble.js";
import { generateText, MAIN_MODEL } from "./llm.js";
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
import { applyExpense } from "./ledger.js";
import { getActiveBillPayForChat, confirmBillPay, cancelBillPay, submitBillPayOtp } from "./billpay.js";

const PORT = Number(process.env.AGENT_PORT) || 3000;
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT) || 3001;
const TARGET_CHAT = process.env.TARGET_CHAT_GUID ?? "";
const NAG_BRIDGE_PORT = Number(process.env.NAG_BRIDGE_PORT) || BRIDGE_PORT;
const NAG_CHAT_ID = process.env.NAG_CHAT_ID || TARGET_CHAT;

const FALLBACK_REPLY = "something went wrong on my end, try again?";

// ── Zombie guards ──────────────────────────────────────────────────────────────
// The agent fires off many background tasks (bridge posts, tool browser jobs,
// simulated calls). A single stray rejection or a broken pipe must NEVER take the
// whole process down — log it and keep serving.
process.on("unhandledRejection", (reason) => {
  log("agent.unhandled_rejection", { reason: String(reason) });
});
process.on("uncaughtException", (err) => {
  // EPIPE happens when stdout is closed (e.g. the dev runner pipe goes away).
  if ((err as NodeJS.ErrnoException).code === "EPIPE") return;
  log("agent.uncaught_exception", { error: String(err && (err as Error).stack || err) });
});
process.stdout.on("error", (err) => {
  if ((err as NodeJS.ErrnoException).code !== "EPIPE") throw err;
});
process.stderr.on("error", () => { /* swallow EPIPE on stderr */ });

const app = express();
app.use(express.json({ limit: "10mb" }));

// ── Health ────────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "hearth-agent" });
});

// ── GTM employee endpoints ──────────────────────────────────────────────────

app.get("/gtm/trend", async (req, res) => {
  const product = typeof req.query.product === "string" && req.query.product.trim()
    ? req.query.product.trim()
    : "eggs";
  try {
    const trend = await getPriceTrend(product);
    res.json(trend);
  } catch (err) {
    log("gtm.trend_error", { product, error: String(err) });
    res.status(500).json({ error: "trend unavailable" });
  }
});

function isPriceTrend(value: unknown): value is PriceTrend {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.product === "string" &&
    typeof v.changePct === "number" &&
    typeof v.period === "string" &&
    typeof v.note === "string"
  );
}

function fallbackGtmPost(trend: PriceTrend): string {
  const dir = trend.changePct >= 0 ? "up" : "down";
  const pct = Math.abs(trend.changePct).toFixed(1).replace(/\.0$/, "");
  return `${trend.product} prices are ${dir} ${pct}% ${trend.period}. kin spots that stuff before the group chat turns into a spreadsheet.`;
}

app.post("/gtm/draft", async (req, res) => {
  const trend = (req.body as { trend?: unknown }).trend;
  if (!isPriceTrend(trend)) {
    res.status(400).json({ error: "expected { trend: { product, changePct, period, note } }" });
    return;
  }

  try {
    const post = await generateText({
      model: MAIN_MODEL,
      systemInstruction:
        "You are Kin's GTM AI marketing employee. Draft one punchy X post for Kin, a household-operations agent in a group chat. Keep it under 240 characters, concrete, lowercase, and do not use hashtags unless one is genuinely useful.",
      prompt: `Price trend from Nimble: ${JSON.stringify(trend)}\n\nDraft a social post that turns this live price trend into a reason to try Kin. Mention Kin by name.`,
    });
    res.json({ post: post || fallbackGtmPost(trend) });
  } catch (err) {
    log("gtm.draft_fallback", { error: String(err) });
    res.json({ post: fallbackGtmPost(trend) });
  }
});

// ── /chat ─────────────────────────────────────────────────────────────────────

interface ChatRequest {
  sender: string;
  text: string;
  chatId: string;
  photoBase64?: string;
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
    const activeJob = await getActiveJobForChat(chatId);

    if (activeJob?.status === "awaiting_approval") {
      if (isCancellationMessage(text)) {
        await cancelOrder(activeJob.id, BRIDGE_PORT);
        res.json({ reply: null });
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
    }

    // Bill-pay sits in its own job store; route approvals/OTP the same way.
    const billJob = await getActiveBillPayForChat(chatId);
    if (billJob?.status === "awaiting_approval") {
      if (isCancellationMessage(text)) {
        void cancelBillPay(billJob.id, BRIDGE_PORT);
        res.json({ reply: null });
        return;
      }
      if (isApprovalMessage(text)) {
        void confirmBillPay(billJob.id, sender, BRIDGE_PORT);
        res.json({ reply: "paying it now 💳" });
        return;
      }
    }
    if (billJob?.status === "awaiting_otp") {
      const code = extractOtpCode(text);
      if (code) {
        void submitBillPayOtp(billJob.id, code, sender, BRIDGE_PORT);
        res.json({ reply: "got it, submitting the code now..." });
        return;
      }
    }

    const resolvedIds = await checkResolution(text, sender);
    if (resolvedIds.length > 0) {
      const resolved = await resolveItems(resolvedIds, sender);
      const reply = buildResolutionAck(resolved);
      log("chat.outbound", { sender, type: "resolution", resolved: resolvedIds });
      res.json({ reply });
      return;
    }

    // A direct address always wins: if someone @-mentions or names hearth, reply
    // no matter the topic. Otherwise stay out of pure peer-to-peer chatter and
    // only chime in when the message touches hearth's domains.
    const addressedToHearth = /(^|\W)@?hearth\b/i.test(text);
    const classification = await classifyMessage(sender, text);

    if (!addressedToHearth && !classification.relevant) {
      log("chat.skipped", { sender, type: classification.type });
      res.json({ reply: null });
      return;
    }

    const photoContext = photoBase64
      ? `\n[Note: ${sender} attached a photo to this message]`
      : "";

    const stateBlock = await buildSerializedState();
    const dispatch = createDispatch({ sender, chatId, bridgePort: BRIDGE_PORT, photoBase64 });

    const reply = await runToolLoop({
      systemInstruction: buildChatSystemPrompt(stateBlock),
      tools: toolDeclarations,
      message: `${sender}: ${text}${photoContext}`,
      dispatch,
    });

    const banned = findBannedWord(reply);
    if (banned) log("chat.tone_violation", { banned });

    log("chat.outbound", { sender, type: classification.type, reply: reply.slice(0, 120) });

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

  res.json({ ok: true });

  const parts = data.split(":");
  const [feature, action, ...rest] = parts;
  const id = rest.join(":");

  try {
    switch (feature) {
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
            await bridgeSend(chatId, await resolveIssue(id, sender));
            break;
          case "send_landlord": {
            const issue = await getIssue(id);
            if (issue && process.env.LANDLORD_MESSAGE_ENABLED === "true") {
              const facts = await getAllFacts();
              const landlordTg = facts["landlord_telegram"];
              if (landlordTg) {
                await bridgeSend(landlordTg, `maintenance request from your tenants:\n\n${issue.description}`);
                await markLandlordNotified(id);
                await bridgeSend(chatId, "sent ✓");
              }
            }
            break;
          }
          case "noop":
            break;
        }
        break;
      }

      case "reorder": {
        if (action === "add") {
          const msg = await applyReorderAdd(id, "auto-reorder");
          await bridgeSend(chatId, msg);
        }
        break;
      }

      case "billpay": {
        switch (action) {
          case "confirm":
            void confirmBillPay(id, sender, BRIDGE_PORT);
            break;
          case "cancel":
            void cancelBillPay(id, BRIDGE_PORT);
            break;
        }
        break;
      }

      case "utility": {
        switch (action) {
          case "split": {
            const bill = await getUtilityBill(id);
            if (!bill) break;
            const members = await getMembers();
            if (members.length === 0) break;

            const account = await getUtilityAccount(bill.accountId);
            const payer = account?.accountHolder ?? "unknown";

            await applyExpense({
              payer,
              amount: bill.amount,
              description: `utility bill (${account?.name ?? "utility"})`,
              splitType: "even",
              beneficiaries: members,
            });

            await patchUtilityBill(id, { status: "paid" });
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
            await patchUtilityBill(id, { status: "skipped" });
            await bridgeSend(chatId, "ok, snoozed 👍");
            break;
          }
        }
        break;
      }

      case "move": {
        const moveEvent = await getMoveEvent(id);
        if (!moveEvent) break;

        switch (action) {
          case "keys_returned":
            await patchMoveEvent(id, { phase: "completed" });
            log("move.completed", { id, member: moveEvent.member });
            await bridgeSend(chatId, `done 🏠 ${moveEvent.member.toLowerCase()}'s all squared away. good luck out there.`);
            break;

          case "deposit_full":
            await patchMoveEvent(id, { phase: "asset_split" });
            await bridgeSend(chatId, `got it — full deposit back to ${moveEvent.member.toLowerCase()}. moving to asset split next.`);
            break;

          case "deposit_deduct":
            await bridgeSend(chatId, `ok, list any damage items and amounts. e.g. "cracked mirror $40". say 'done' when finished.`);
            break;

          case "onboard_done":
            await patchMoveEvent(id, { phase: "completed" });
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

// ── Order management endpoints ─────────────────────────────────────────────────

app.post("/order/:jobId/approve", async (req, res) => {
  const job = await getOrderJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: "job not found" }); return; }
  void approveAndCheckout(job.id, "api", BRIDGE_PORT);
  res.json({ ok: true, jobId: job.id });
});

app.post("/order/:jobId/cancel", async (req, res) => {
  const job = await getOrderJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: "job not found" }); return; }
  void cancelOrder(job.id, BRIDGE_PORT);
  res.json({ ok: true });
});

app.post("/order/:jobId/edit", async (req, res) => {
  const job = await getOrderJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: "job not found" }); return; }
  const { instruction } = req.body as { instruction?: string };
  if (!instruction) { res.status(400).json({ error: "instruction required" }); return; }
  void editCart(job.id, instruction, BRIDGE_PORT);
  res.json({ ok: true });
});

app.post("/order/:jobId/otp", async (req, res) => {
  const job = await getOrderJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: "job not found" }); return; }
  const { code } = req.body as { code?: string };
  if (!code) { res.status(400).json({ error: "code required" }); return; }
  void submitOtp(job.id, code, "api", BRIDGE_PORT);
  res.json({ ok: true });
});

app.get("/order/:jobId", async (req, res) => {
  const job = await getOrderJob(req.params.jobId);
  if (!job) { res.status(404).json({ error: "job not found" }); return; }
  res.json(job);
});

// ── State management endpoints ────────────────────────────────────────────────

app.post("/members", async (req, res) => {
  const { members } = req.body as { members?: unknown };
  if (!Array.isArray(members) || !members.every((m) => typeof m === "string")) {
    res.status(400).json({ error: "expected { members: string[] }" });
    return;
  }
  await setMembers(members as string[]);
  log("state.members_set", { members });
  res.json({ ok: true, members });
});

app.get("/balances", async (_req, res) => {
  const [members, balances] = await Promise.all([getMembers(), getAllBalances()]);
  res.json(Object.fromEntries(members.map((m) => [m, balances[m] ?? 0])));
});

app.post("/facts", async (req, res) => {
  const { key, value } = req.body as { key?: unknown; value?: unknown };
  if (typeof key !== "string" || typeof value !== "string") {
    res.status(400).json({ error: "expected { key: string, value: string }" });
    return;
  }
  await setFact(key, value);
  log("state.fact_set", { key, value });
  const facts = await getAllFacts();
  res.json({ ok: true, facts });
});

app.delete("/facts/:key", async (req, res) => {
  await deleteFact(req.params.key);
  log("state.fact_deleted", { key: req.params.key });
  const facts = await getAllFacts();
  res.json({ ok: true, facts });
});

app.get("/facts", async (_req, res) => {
  res.json(await getAllFacts());
});

app.get("/nag-check", async (_req, res) => {
  const nags = await checkNags();
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
  const nags = await checkNags();
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

setInterval(() => {
  dispatchNags().catch((err) => log("nag.scheduler_error", { error: String(err) }));
}, 60 * 60 * 1_000);

// ── Utility spike investigation ───────────────────────────────────────────────

async function investigateUtilitySpike(billId: string, chatId: string): Promise<void> {
  const { getUtilityBill: getBill, getUtilityAccount: getAccount } = await import("./db.js");
  const bill = await getBill(billId);
  if (!bill || !process.env.BROWSERBASE_API_KEY) return;

  const account = await getAccount(bill.accountId);
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

const server = app.listen(PORT, () => {
  log("agent.started", { port: PORT });
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    log("agent.port_in_use", { port: PORT, hint: `another process is on :${PORT} — kill it: lsof -ti:${PORT} | xargs kill` });
  } else {
    log("agent.listen_error", { error: String(err) });
  }
  process.exit(1);
});
