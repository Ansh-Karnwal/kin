import { orderJobs, state, type OrderJob, type OrderCartItem } from "../state.js";
import { log } from "../log.js";

export function createOrderJob(chatId: string, note?: string): OrderJob | null {
  const items = state.groceryList
    .filter((g) => !g.fulfilled)
    .map((g) => ({ name: g.item, requestedBy: g.requestedBy }));

  if (items.length === 0) return null;

  const job: OrderJob = {
    id: `order_${Date.now()}`,
    chatId,
    status: "building",
    items,
    note,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  orderJobs.set(job.id, job);
  log("order.created", { jobId: job.id, chatId, itemCount: items.length });
  return job;
}

export function getOrderJob(id: string): OrderJob | undefined {
  return orderJobs.get(id);
}

/** Returns the first non-terminal job for this chat, or undefined. */
export function getActiveJobForChat(chatId: string): OrderJob | undefined {
  const terminal: OrderJob["status"][] = ["done", "failed", "cancelled"];
  for (const job of orderJobs.values()) {
    if (job.chatId === chatId && !terminal.includes(job.status)) return job;
  }
  return undefined;
}

export function updateOrderJob(id: string, patch: Partial<OrderJob>): void {
  const job = orderJobs.get(id);
  if (!job) return;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  log("order.updated", { jobId: id, status: job.status });
}

/** Apply the completed cart to the ledger, splitting costs by item requester. */
export function applyOrderToLedger(
  job: OrderJob,
  payer: string,
  splitEvenly: boolean = false
): string {
  if (!job.cart || !job.subtotal) return "no cart data to split";

  const { money, state: s } = (() => {
    // Inline to avoid circular import
    const fmt = (n: number) => {
      const fixed = Math.abs(n).toFixed(2);
      return `$${fixed.endsWith(".00") ? fixed.slice(0, -3) : fixed}`;
    };
    return { money: fmt, state };
  })();

  const members = s.members;
  if (members.length === 0) return "no members configured";

  const charges: Record<string, number> = {};

  if (splitEvenly || job.note?.toLowerCase().includes("split evenly")) {
    const perPerson = job.subtotal / members.length;
    for (const m of members) charges[m] = perPerson;
  } else {
    // Build a requester → total charged map using item prices from the cart
    for (const cartItem of job.cart) {
      const groceryItem = job.items.find(
        (i) => i.name.toLowerCase() === cartItem.name.toLowerCase()
      );
      const requester = groceryItem?.requestedBy ?? "everyone";
      if (requester === "everyone") {
        const share = cartItem.price / members.length;
        for (const m of members) charges[m] = (charges[m] ?? 0) + share;
      } else {
        charges[requester] = (charges[requester] ?? 0) + cartItem.price;
      }
    }
  }

  // Credit the payer; debit each charged member
  s.balances[payer] = (s.balances[payer] ?? 0) + job.subtotal;
  for (const [member, amount] of Object.entries(charges)) {
    s.balances[member] = (s.balances[member] ?? 0) - amount;
  }

  s.ledger.push({
    payer,
    amount: job.subtotal,
    description: "grocery order",
    split: members,
    timestamp: new Date().toISOString(),
  });

  // Stamp the run and clear fulfilled items
  s.lastGroceryRun = new Date().toISOString();
  s.groceryList = s.groceryList.filter((g) => g.fulfilled);

  const breakdown = Object.entries(charges)
    .map(([m, amt]) => `${m.toLowerCase()} ${money(amt)}`)
    .join(", ");

  log("order.split_applied", { jobId: job.id, payer, subtotal: job.subtotal, breakdown });
  return `done — split: ${breakdown}. added to the tab.`;
}

/** Format cart items for a human-readable approval message. */
export function formatCartSummary(job: OrderJob): string {
  if (!job.cart || !job.subtotal) return "cart not built yet";
  const itemCount = job.cart.reduce((sum, i) => sum + i.quantity, 0);
  return `cart's ready 🧾 ${itemCount} items, $${job.subtotal.toFixed(2)}. good to go? reply 'yes' or tell me what to change`;
}

/** True when the message is a clear approval of the pending order. */
export function isApprovalMessage(text: string): boolean {
  const t = text.toLowerCase().trim();
  // Approval phrases — without "but/except/drop/change" qualifiers
  const approved = /^(yes|yeah|yep|yup|go|do it|looks good|go ahead|ok|okay|✓|👍|sounds good)/.test(t);
  const hasEdit = /\b(but|except|drop|remove|change|make it|without|swap|instead)\b/.test(t);
  return approved && !hasEdit;
}

/** True when the message contains an edit to the cart alongside approval. */
export function isEditMessage(text: string): boolean {
  const t = text.toLowerCase().trim();
  const hasApproval = /(yes|yeah|go|ok|okay|but|drop|remove|change|make it|without|swap)/.test(t);
  const hasEdit = /\b(drop|remove|change|make it|without|swap|instead|except|add)\b/.test(t);
  return hasApproval && hasEdit;
}

/** True when the message is a cancellation. */
export function isCancellationMessage(text: string): boolean {
  const t = text.toLowerCase().trim();
  return /^(no|nope|cancel|stop|don't|never mind|forget it)/.test(t);
}

/** Parse the OTP code from a chat message. */
export function extractOtpCode(text: string): string | null {
  const match = text.match(/\b(\d{4,8})\b/);
  return match ? match[1] : null;
}

export type { OrderJob, OrderCartItem };
