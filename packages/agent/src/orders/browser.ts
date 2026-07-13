import { log } from "../log.js";
import {
  getOrderJob,
  updateOrderJob,
  formatCartSummary,
  applyOrderToLedger,
  type OrderJob,
} from "./jobs.js";
import { updateConsumptionPattern } from "../reorder.js";

const DRY_RUN = process.env.ORDER_DRY_RUN !== "false";
const MAX_ORDER_TOTAL = Number(process.env.MAX_ORDER_TOTAL ?? 150);
const GROCERY_STORE_URL = process.env.GROCERY_STORE_URL ?? "https://www.instacart.com";

// ── Bridge helpers ────────────────────────────────────────────────────────────

async function bridgeSend(chatId: string, message: string, bridgePort: number): Promise<void> {
  try {
    await fetch(`http://localhost:${bridgePort}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, message }),
    });
  } catch (err) {
    log("browser.bridge_send_failed", { chatId, error: String(err) });
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
    log("browser.bridge_send_keyboard_failed", { chatId, error: String(err) });
  }
}

// ── Stagehand factory helpers ─────────────────────────────────────────────────

// Dynamic import so the module loads even when Browserbase isn't configured.
// V3Options takes model as ModelConfiguration = AvailableModel | (ClientOptions & { modelName })
async function createStagehand() {
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
          id: process.env.BROWSERBASE_CONTEXT_ID!,
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

// ── Cart building ─────────────────────────────────────────────────────────────

export async function buildCart(jobId: string, bridgePort: number): Promise<void> {
  const job = getOrderJob(jobId);
  if (!job) return;

  log("order.build_start", { jobId, chatId: job.chatId, dryRun: DRY_RUN, itemCount: job.items.length });

  if (DRY_RUN) {
    await handleDryRun(job, bridgePort);
    return;
  }

  if (!process.env.BROWSERBASE_API_KEY || !process.env.BROWSERBASE_PROJECT_ID) {
    log("order.build_skipped", { reason: "BROWSERBASE_API_KEY or PROJECT_ID not set" });
    updateOrderJob(jobId, { status: "failed" });
    await bridgeSend(
      job.chatId,
      "can't build the cart — browserbase isn't configured. set BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID in .env",
      bridgePort
    );
    return;
  }

  let stagehand: Awaited<ReturnType<typeof createStagehand>> | null = null;

  const heartbeatTimer = setTimeout(() => {
    void bridgeSend(job.chatId, "still working on the cart... 🛒", bridgePort);
  }, 120_000);

  try {
    stagehand = await createStagehand();
    await stagehand.init();

    updateOrderJob(jobId, { sessionId: stagehand.browserbaseSessionID });

    // Navigate via act() — V3 has no direct page.goto()
    await stagehand.act(`navigate to ${GROCERY_STORE_URL}`);

    for (const { name } of job.items) {
      log("order.adding_item", { jobId, item: name });
      try {
        await stagehand.act(`search for ${name} and add the first matching result to the cart`);
      } catch (itemErr) {
        log("order.item_failed", { jobId, item: name, error: String(itemErr) });
      }
    }

    const { z } = await import("zod");
    const CartSchema = z.object({
      items: z.array(z.object({
        name: z.string(),
        quantity: z.number(),
        price: z.number(),
      })),
      subtotal: z.number(),
    });

    const extracted = await stagehand.extract(
      "extract every item in the cart with its name, quantity, and unit price, plus the order subtotal",
      CartSchema
    );

    updateOrderJob(jobId, {
      cart: extracted.items,
      subtotal: extracted.subtotal,
      status: "awaiting_approval",
    });

    clearTimeout(heartbeatTimer);

    const updatedJob = getOrderJob(jobId)!;
    const caption = formatCartSummary(updatedJob);

    await bridgeSendKeyboard(
      job.chatId,
      `🧾 ${caption}`,
      [[
        { text: "✅ Place order", callback_data: `order:approve:${jobId}` },
        { text: "❌ Cancel", callback_data: `order:cancel:${jobId}` },
      ]],
      bridgePort
    );

    log("order.awaiting_approval", { jobId, subtotal: extracted.subtotal, itemCount: extracted.items.length });
    // DO NOT close — keepAlive holds the session for the approval pause
  } catch (err) {
    clearTimeout(heartbeatTimer);
    log("order.build_failed", { jobId, error: String(err) });
    updateOrderJob(jobId, { status: "failed" });
    if (stagehand) {
      try { await stagehand.close(); } catch { /* best-effort */ }
    }
    await bridgeSend(
      job.chatId,
      "couldn't build the cart — something went wrong on the instacart side. want to try again?",
      bridgePort
    );
  }
}

// ── Checkout ──────────────────────────────────────────────────────────────────

export async function approveAndCheckout(
  jobId: string,
  approvedBy: string,
  bridgePort: number
): Promise<void> {
  const job = getOrderJob(jobId);
  if (!job || job.status !== "awaiting_approval") return;

  if (!job.subtotal || job.subtotal > MAX_ORDER_TOTAL) {
    await bridgeSend(
      job.chatId,
      `order total $${(job.subtotal ?? 0).toFixed(2)} is over the $${MAX_ORDER_TOTAL} limit — not checking out. want to remove some items?`,
      bridgePort
    );
    return;
  }

  if (DRY_RUN) {
    updateOrderJob(jobId, { status: "done" });
    const split = applyOrderToLedger(job, approvedBy, job.note?.toLowerCase().includes("split evenly"));
    await bridgeSend(job.chatId, `dry run — would have placed the order. ${split}`, bridgePort);
    return;
  }

  if (!job.sessionId) {
    await bridgeSend(job.chatId, "lost the session — want me to rebuild the cart?", bridgePort);
    updateOrderJob(jobId, { status: "failed" });
    return;
  }

  updateOrderJob(jobId, { status: "placing" });

  let stagehand: Awaited<ReturnType<typeof resumeStagehand>> | null = null;

  try {
    stagehand = await resumeStagehand(job.sessionId);
    await stagehand.init();

    // agent().execute() for messy multi-step checkout
    await stagehand.agent().execute(
      "proceed to checkout and stop at the order review page — do not place the order yet"
    );

    // Check for OTP prompt
    const otpCheck = await stagehand.observe(
      "is there a phone verification or one-time code field on this page?"
    );

    const needsOtp = otpCheck.some((action) =>
      JSON.stringify(action).toLowerCase().includes("code")
    );

    if (needsOtp) {
      updateOrderJob(jobId, { status: "awaiting_otp", sessionId: stagehand!.browserbaseSessionID });
      await bridgeSend(
        job.chatId,
        "site wants a verification code — what'd you get texted? 📲",
        bridgePort
      );
      return;
    }

    await stagehand.act("click the place order button to complete the purchase");
    updateOrderJob(jobId, { status: "done" });

    const split = applyOrderToLedger(job, approvedBy, job.note?.toLowerCase().includes("split evenly"));

    for (const item of job.items) {
      updateConsumptionPattern(item.name, item.requestedBy);
    }

    await bridgeSend(job.chatId, `done 🏠 order's in. ${split}`, bridgePort);
    log("order.placed", { jobId, approvedBy, subtotal: job.subtotal });
  } catch (err) {
    log("order.checkout_failed", { jobId, error: String(err) });
    updateOrderJob(jobId, { status: "failed" });
    if (stagehand) {
      try { await stagehand.close(); } catch { /* best-effort */ }
    }
    await bridgeSend(
      job.chatId,
      "ran into a problem at checkout — may have been logged out. try running it again?",
      bridgePort
    );
  }
}

// ── OTP submission ────────────────────────────────────────────────────────────

export async function submitOtp(
  jobId: string,
  code: string,
  approvedBy: string,
  bridgePort: number
): Promise<void> {
  const job = getOrderJob(jobId);
  if (!job || job.status !== "awaiting_otp" || !job.sessionId) return;

  updateOrderJob(jobId, { status: "placing" });

  let stagehand: Awaited<ReturnType<typeof resumeStagehand>> | null = null;

  try {
    stagehand = await resumeStagehand(job.sessionId);
    await stagehand.init();

    await stagehand.act(`enter the verification code ${code} and submit`);
    await stagehand.act("click the place order button to complete the purchase");

    updateOrderJob(jobId, { status: "done" });

    const split = applyOrderToLedger(job, approvedBy, job.note?.toLowerCase().includes("split evenly"));

    for (const item of job.items) {
      updateConsumptionPattern(item.name, item.requestedBy);
    }

    await bridgeSend(job.chatId, `order placed 🏠 ${split}`, bridgePort);
    log("order.otp_completed", { jobId, approvedBy });
  } catch (err) {
    log("order.otp_failed", { jobId, error: String(err) });
    updateOrderJob(jobId, { status: "failed" });
    if (stagehand) {
      try { await stagehand.close(); } catch { /* best-effort */ }
    }
    await bridgeSend(job.chatId, "something went wrong after the code — check instacart to confirm", bridgePort);
  }
}

// ── Cancel ────────────────────────────────────────────────────────────────────

export async function cancelOrder(jobId: string, bridgePort: number): Promise<void> {
  const job = getOrderJob(jobId);
  if (!job) return;

  updateOrderJob(jobId, { status: "cancelled" });

  if (job.sessionId && !DRY_RUN) {
    try {
      const s = await resumeStagehand(job.sessionId);
      await s.init();
      await s.close();
    } catch { /* best-effort */ }
  }

  await bridgeSend(job.chatId, "order cancelled 🗑️ list is still there if you want to try again", bridgePort);
  log("order.cancelled", { jobId });
}

// ── Cart edit ─────────────────────────────────────────────────────────────────

export async function editCart(
  jobId: string,
  instruction: string,
  bridgePort: number
): Promise<void> {
  const job = getOrderJob(jobId);
  if (!job || !job.sessionId) {
    await bridgeSend(job?.chatId ?? "", "lost the session, can't edit — want me to rebuild?", bridgePort);
    return;
  }

  let stagehand: Awaited<ReturnType<typeof resumeStagehand>> | null = null;

  try {
    stagehand = await resumeStagehand(job.sessionId);
    await stagehand.init();

    await stagehand.act(instruction);

    const { z } = await import("zod");
    const CartSchema = z.object({
      items: z.array(z.object({ name: z.string(), quantity: z.number(), price: z.number() })),
      subtotal: z.number(),
    });

    const extracted = await stagehand.extract(
      "extract every item in the cart with its name, quantity, and price, plus the order subtotal",
      CartSchema
    );

    updateOrderJob(jobId, { cart: extracted.items, subtotal: extracted.subtotal });

    const updatedJob = getOrderJob(jobId)!;
    const caption = formatCartSummary(updatedJob);

    await bridgeSendKeyboard(
      job.chatId,
      `updated 👆 ${caption}`,
      [[
        { text: "✅ Place order", callback_data: `order:approve:${jobId}` },
        { text: "❌ Cancel", callback_data: `order:cancel:${jobId}` },
      ]],
      bridgePort
    );
    log("order.edited", { jobId, instruction });
  } catch (err) {
    log("order.edit_failed", { jobId, error: String(err) });
    if (stagehand) {
      try { await stagehand.close(); } catch { /* best-effort */ }
    }
    await bridgeSend(job.chatId, "couldn't apply that change — try telling me what to fix again", bridgePort);
  }
}

// ── Dry-run simulation ────────────────────────────────────────────────────────

async function handleDryRun(job: OrderJob, bridgePort: number): Promise<void> {
  const fakeCart = job.items.map((i, idx) => ({
    name: i.name,
    quantity: 1,
    price: parseFloat((3.99 + idx * 0.5).toFixed(2)),
  }));
  const fakeSubtotal = parseFloat(
    fakeCart.reduce((s, i) => s + i.price, 0).toFixed(2)
  );

  updateOrderJob(job.id, {
    cart: fakeCart,
    subtotal: fakeSubtotal,
    status: "awaiting_approval",
  });

  const itemList = fakeCart
    .map((i) => `${i.name} ($${i.price.toFixed(2)})`)
    .join(", ");

  await bridgeSendKeyboard(
    job.chatId,
    `[DRY RUN 🧪] ${itemList}\ntotal: $${fakeSubtotal.toFixed(2)} — approve to simulate (no real purchase)`,
    [[
      { text: "✅ Simulate approval", callback_data: `order:approve:${job.id}` },
      { text: "❌ Cancel", callback_data: `order:cancel:${job.id}` },
    ]],
    bridgePort
  );

  log("order.dry_run", { jobId: job.id, fakeSubtotal, itemCount: fakeCart.length });
}
