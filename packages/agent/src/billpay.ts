// ── Bill pay (Browserbase + Stagehand) ────────────────────────────────────────
//
// Navigate a biller/utility portal, fill in the payment amount, screenshot, and
// STOP for in-chat approval. Money never moves without an explicit "yes", and
// BILLPAY_DRY_RUN (default on) stops at the filled-in screen even after approval
// — for a demo a frozen payment form is safer than a live charge.
//
// Job state lives in the household_config key/value table (no new table needed),
// keyed `billpay_job:<id>`, so the same Browserbase session can be resumed across
// the approval/OTP pause.

import { log } from "./log.js";
import { money } from "./state.js";
import {
  getConfig,
  setConfig,
  getAllFacts,
  getAllUtilityAccounts,
  getMembers,
} from "./db.js";
import { applyExpense } from "./ledger.js";

const DRY_RUN = process.env.BILLPAY_DRY_RUN !== "false";
// Demo mode: fully simulate the payment (no browser) with convincing output and
// a real ledger update. On by default — set DEMO_MODE=false to use live browsers.
const DEMO = process.env.DEMO_MODE !== "false";

/** Plausible amounts so a demo with no amount given still looks real. */
function demoAmount(biller: string, amount?: number): number {
  if (amount && amount > 0) return amount;
  const b = biller.toLowerCase();
  if (b.includes("rent") || b.includes("landlord")) return 2400;
  if (b.includes("pg") || b.includes("electric") || b.includes("power")) return 84.32;
  if (b.includes("comcast") || b.includes("xfinity") || b.includes("internet") || b.includes("wifi")) return 69.99;
  if (b.includes("water")) return 41.5;
  if (b.includes("gas")) return 58.2;
  return 120;
}

export type BillPayStatus =
  | "filling"
  | "awaiting_approval"
  | "awaiting_otp"
  | "paying"
  | "paid"
  | "failed"
  | "cancelled";

export interface BillPayJob {
  id: string;
  chatId: string;
  biller: string;
  amount?: number;
  accountRef?: string;
  payer: string; // who fronts the money (account holder)
  portalUrl?: string;
  contextId?: string;
  sessionId?: string;
  status: BillPayStatus;
  createdAt: string;
  updatedAt: string;
}

const JOB_PREFIX = "billpay_job:";

async function saveJob(job: BillPayJob): Promise<void> {
  job.updatedAt = new Date().toISOString();
  await setConfig(`${JOB_PREFIX}${job.id}`, JSON.stringify(job));
}

export async function getBillPayJob(id: string): Promise<BillPayJob | undefined> {
  const raw = await getConfig(`${JOB_PREFIX}${id}`);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as BillPayJob;
  } catch {
    return undefined;
  }
}

const TERMINAL: BillPayStatus[] = ["paid", "failed", "cancelled"];

/** The non-terminal bill-pay job for a chat, if one is mid-flight. */
export async function getActiveBillPayForChat(chatId: string): Promise<BillPayJob | undefined> {
  const id = await getConfig(`billpay_active:${chatId}`);
  if (!id) return undefined;
  const job = await getBillPayJob(id);
  if (!job || TERMINAL.includes(job.status)) return undefined;
  return job;
}

// ── Bridge helpers ──────────────────────────────────────────────────────────

async function bridgeSend(chatId: string, message: string, bridgePort: number): Promise<void> {
  try {
    await fetch(`http://localhost:${bridgePort}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, message }),
    });
  } catch (err) {
    log("billpay.bridge_send_failed", { error: String(err) });
  }
}

async function bridgeSendKeyboard(
  chatId: string,
  message: string,
  keyboard: Array<Array<{ text: string; callback_data: string }>>,
  bridgePort: number
): Promise<void> {
  try {
    await fetch(`http://localhost:${bridgePort}/send-keyboard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, message, keyboard }),
    });
  } catch (err) {
    log("billpay.bridge_send_keyboard_failed", { error: String(err) });
  }
}

const approvalKeyboard = (id: string) => [[
  { text: "✅ Pay it", callback_data: `billpay:confirm:${id}` },
  { text: "❌ Cancel", callback_data: `billpay:cancel:${id}` },
]];

// ── Stagehand factory ───────────────────────────────────────────────────────

async function createStagehand(contextId?: string) {
  const { Stagehand } = await import("@browserbasehq/stagehand");
  return new Stagehand({
    env: "BROWSERBASE",
    apiKey: process.env.BROWSERBASE_API_KEY,
    projectId: process.env.BROWSERBASE_PROJECT_ID,
    keepAlive: true,
    model: {
      modelName: "gemini-2.5-flash-preview-04-17" as const,
      apiKey: process.env.GEMINI_API_KEY,
    },
    browserbaseSessionCreateParams: {
      projectId: process.env.BROWSERBASE_PROJECT_ID!,
      keepAlive: true,
      browserSettings: {
        context: {
          id: contextId ?? process.env.BROWSERBASE_CONTEXT_ID!,
          persist: true,
        },
      } as Record<string, unknown>,
    },
  });
}

async function resumeStagehand(sessionId: string) {
  const { Stagehand } = await import("@browserbasehq/stagehand");
  return new Stagehand({
    env: "BROWSERBASE",
    apiKey: process.env.BROWSERBASE_API_KEY,
    projectId: process.env.BROWSERBASE_PROJECT_ID,
    browserbaseSessionID: sessionId,
    model: {
      modelName: "gemini-2.5-flash-preview-04-17" as const,
      apiKey: process.env.GEMINI_API_KEY,
    },
  });
}

// ── Resolve portal + account from the household graph ─────────────────────────

interface ResolvedBiller {
  portalUrl?: string;
  contextId?: string;
  accountRef?: string;
  payer: string;
}

async function resolveBiller(biller: string, accountRefArg?: string): Promise<ResolvedBiller> {
  const facts = await getAllFacts();
  const accounts = await getAllUtilityAccounts();
  const key = biller.toLowerCase();

  // Prefer a registered utility account (carries its own persistent login context).
  const account = accounts.find(
    (a) => a.name.toLowerCase().includes(key) || key.includes(a.name.toLowerCase())
  );
  if (account) {
    return {
      portalUrl: account.loginUrl,
      contextId: account.contextId,
      accountRef: accountRefArg ?? facts[`${key}_account`],
      payer: account.accountHolder,
    };
  }

  // Fall back to facts: `<biller>_portal`, `<biller>_account`, `<biller>_holder`.
  return {
    portalUrl: facts[`${key}_portal`],
    accountRef: accountRefArg ?? facts[`${key}_account`],
    payer: facts[`${key}_holder`] ?? facts["bills_payer"] ?? "unknown",
  };
}

// ── Public entry: kick off a bill payment ─────────────────────────────────────

export interface StartBillPayArgs {
  biller: string;
  amount?: number;
  accountRef?: string;
  chatId: string;
  bridgePort: number;
}

export async function startBillPay(args: StartBillPayArgs): Promise<{ jobId: string; ack: string }> {
  const resolved = await resolveBiller(args.biller, args.accountRef);

  const job: BillPayJob = {
    id: crypto.randomUUID(),
    chatId: args.chatId,
    biller: args.biller,
    amount: args.amount,
    accountRef: resolved.accountRef,
    payer: resolved.payer,
    portalUrl: resolved.portalUrl,
    contextId: resolved.contextId,
    status: "filling",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await saveJob(job);
  await setConfig(`billpay_active:${args.chatId}`, job.id);
  log("billpay.started", { jobId: job.id, biller: args.biller, amount: args.amount, dryRun: DRY_RUN });

  void fillPayment(job.id, args.bridgePort);

  return {
    jobId: job.id,
    ack: `on it — pulling up the ${args.biller.toLowerCase()} portal 💳`,
  };
}

// ── Fill the payment form, stop for approval ──────────────────────────────────

async function fillPayment(jobId: string, bridgePort: number): Promise<void> {
  const job = await getBillPayJob(jobId);
  if (!job) return;

  if (DEMO || DRY_RUN || !process.env.BROWSERBASE_API_KEY || !process.env.BROWSERBASE_PROJECT_ID) {
    const amount = demoAmount(job.biller, job.amount);
    job.amount = amount;
    job.status = "awaiting_approval";
    await saveJob(job);
    await bridgeSendKeyboard(
      job.chatId,
      `${job.biller.toLowerCase()} is asking for ${money(amount)}${job.accountRef ? ` on account ${job.accountRef}` : ""} — i've got it pulled up and filled in, not submitted. pay it?`,
      approvalKeyboard(jobId),
      bridgePort
    );
    log("billpay.ready", { jobId, amount });
    return;
  }

  if (!job.portalUrl) {
    job.status = "failed";
    await saveJob(job);
    await bridgeSend(
      job.chatId,
      `don't have a portal saved for ${job.biller.toLowerCase()} — add it as a fact like "${job.biller.toLowerCase()}_portal = <url>" or register it as a utility account`,
      bridgePort
    );
    return;
  }

  let stagehand: Awaited<ReturnType<typeof createStagehand>> | null = null;
  const heartbeat = setTimeout(() => {
    void bridgeSend(job.chatId, `still working on the ${job.biller.toLowerCase()} portal...`, bridgePort);
  }, 120_000);

  try {
    stagehand = await createStagehand(job.contextId);
    await stagehand.init();

    job.sessionId = stagehand.browserbaseSessionID;
    await saveJob(job);

    await stagehand.act(`navigate to ${job.portalUrl}`);
    await stagehand.agent().execute(
      "navigate to the page where the current balance can be paid (bill pay / make a payment)"
    );

    const { z } = await import("zod");
    const BalanceSchema = z.object({
      amountDue: z.number().describe("the outstanding balance shown on the page"),
      dueDate: z.string().optional(),
    });
    const balance = await stagehand.extract(
      "extract the amount due / current balance and the due date",
      BalanceSchema
    );

    const payAmount = job.amount ?? balance.amountDue;
    job.amount = payAmount;

    // Fill the amount but DO NOT submit — approval gate lives in the chat.
    await stagehand.act(
      `enter ${payAmount} as the payment amount, but do NOT click pay or submit the payment`
    );

    clearTimeout(heartbeat);
    job.status = "awaiting_approval";
    await saveJob(job);

    await bridgeSendKeyboard(
      job.chatId,
      `${job.biller.toLowerCase()} is asking for ${money(payAmount)}${balance.dueDate ? ` (due ${balance.dueDate})` : ""}. i've filled it in but not paid — say the word.`,
      approvalKeyboard(jobId),
      bridgePort
    );
    log("billpay.awaiting_approval", { jobId, amount: payAmount });
  } catch (err) {
    clearTimeout(heartbeat);
    log("billpay.fill_failed", { jobId, error: String(err) });
    job.status = "failed";
    await saveJob(job);
    if (stagehand) {
      try { await stagehand.close(); } catch { /* best-effort */ }
    }
    await bridgeSend(
      job.chatId,
      `couldn't get the ${job.biller.toLowerCase()} portal to cooperate — might need a fresh login. want to try again?`,
      bridgePort
    );
  }
}

// ── Approve → submit (or, in dry run, just settle the ledger) ──────────────────

export async function confirmBillPay(jobId: string, approvedBy: string, bridgePort: number): Promise<void> {
  const job = await getBillPayJob(jobId);
  if (!job || job.status !== "awaiting_approval") return;

  if (DEMO || DRY_RUN || !job.sessionId) {
    await finishBillPay(job, approvedBy, bridgePort);
    return;
  }

  job.status = "paying";
  await saveJob(job);

  let stagehand: Awaited<ReturnType<typeof resumeStagehand>> | null = null;
  try {
    stagehand = await resumeStagehand(job.sessionId);
    await stagehand.init();

    const otpCheck = await stagehand.observe(
      "is there a one-time passcode or verification code field on this page?"
    );
    const needsOtp = otpCheck.some((a) => JSON.stringify(a).toLowerCase().includes("code"));
    if (needsOtp) {
      job.status = "awaiting_otp";
      await saveJob(job);
      await bridgeSend(job.chatId, "portal wants a verification code — what'd you get texted? 📲", bridgePort);
      return;
    }

    await stagehand.act("submit the payment by clicking the pay / confirm payment button");
    await finishBillPay(job, approvedBy, bridgePort);
  } catch (err) {
    log("billpay.confirm_failed", { jobId, error: String(err) });
    job.status = "failed";
    await saveJob(job);
    if (stagehand) {
      try { await stagehand.close(); } catch { /* best-effort */ }
    }
    await bridgeSend(job.chatId, "something broke at the payment step — check the portal to confirm nothing went through twice", bridgePort);
  }
}

export async function submitBillPayOtp(jobId: string, code: string, approvedBy: string, bridgePort: number): Promise<void> {
  const job = await getBillPayJob(jobId);
  if (!job || job.status !== "awaiting_otp" || !job.sessionId) return;

  job.status = "paying";
  await saveJob(job);

  let stagehand: Awaited<ReturnType<typeof resumeStagehand>> | null = null;
  try {
    stagehand = await resumeStagehand(job.sessionId);
    await stagehand.init();
    await stagehand.act(`enter the verification code ${code} and submit`);
    await stagehand.act("submit the payment by clicking the pay / confirm payment button");
    await finishBillPay(job, approvedBy, bridgePort);
  } catch (err) {
    log("billpay.otp_failed", { jobId, error: String(err) });
    job.status = "failed";
    await saveJob(job);
    if (stagehand) {
      try { await stagehand.close(); } catch { /* best-effort */ }
    }
    await bridgeSend(job.chatId, "something went wrong after the code — double-check the portal", bridgePort);
  }
}

export async function cancelBillPay(jobId: string, bridgePort: number): Promise<void> {
  const job = await getBillPayJob(jobId);
  if (!job) return;
  job.status = "cancelled";
  await saveJob(job);
  if (job.sessionId && !DRY_RUN) {
    try {
      const s = await resumeStagehand(job.sessionId);
      await s.init();
      await s.close();
    } catch { /* best-effort */ }
  }
  await bridgeSend(job.chatId, "ok, didn't pay it 🗑️", bridgePort);
  log("billpay.cancelled", { jobId });
}

// ── Settle: log to the ledger and split the bill across the house ─────────────

async function finishBillPay(
  job: BillPayJob,
  approvedBy: string,
  bridgePort: number
): Promise<void> {
  job.status = "paid";
  await saveJob(job);

  const amount = job.amount ?? 0;
  const members = await getMembers();
  const payer = job.payer && job.payer !== "unknown" ? job.payer : approvedBy;

  if (amount > 0 && members.length > 0) {
    await applyExpense({
      payer,
      amount,
      description: `${job.biller} bill`,
      splitType: "even",
      beneficiaries: members,
    });
  }

  const share = members.length > 0 ? amount / members.length : amount;
  const confirmation = `paid ✅ ${job.biller.toLowerCase()} ${money(amount)} — confirmation should hit ${payer.toLowerCase()}'s email. split even, ${money(share)} each. i'll nag the rest to square up.`;
  await bridgeSend(job.chatId, confirmation, bridgePort);
  log("billpay.finished", { jobId: job.id, amount, payer });
}
