import {
  getOrderJobById,
  getActiveJobForChatDb,
  addOrderJob,
  patchOrderJob,
  getGroceryItems,
  getMembers,
  getAllBalances,
  adjustBalance,
  addLedgerEntry,
  setConfig,
  deleteAllFulfilledGrocery,
} from "../db.js";
import { log } from "../log.js";
import { money } from "../state.js";
import type { OrderJob, OrderCartItem } from "../state.js";

export async function createOrderJob(chatId: string, note?: string): Promise<OrderJob | null> {
  const openItems = await getGroceryItems(true);
  if (openItems.length === 0) return null;

  const job: OrderJob = {
    id: crypto.randomUUID(),
    chatId,
    status: "building",
    items: openItems.map((g) => ({ name: g.item, requestedBy: g.requestedBy })),
    note,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await addOrderJob(job);
  log("order.created", { jobId: job.id, chatId, itemCount: job.items.length });
  return job;
}

export async function getOrderJob(id: string): Promise<OrderJob | undefined> {
  return getOrderJobById(id);
}

export async function getActiveJobForChat(chatId: string): Promise<OrderJob | undefined> {
  return getActiveJobForChatDb(chatId);
}

export async function updateOrderJob(id: string, p: Partial<OrderJob>): Promise<void> {
  await patchOrderJob(id, p);
  log("order.updated", { jobId: id, status: p.status });
}

/** Apply the completed cart to the ledger, splitting costs by item requester. */
export async function applyOrderToLedger(
  job: OrderJob,
  payer: string,
  splitEvenly = false
): Promise<string> {
  if (!job.cart || !job.subtotal) return "no cart data to split";

  const members = await getMembers();
  if (members.length === 0) return "no members configured";

  const charges: Record<string, number> = {};

  if (splitEvenly || job.note?.toLowerCase().includes("split evenly")) {
    const perPerson = job.subtotal / members.length;
    for (const m of members) charges[m] = perPerson;
  } else {
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

  // Credit payer; debit each charged member
  await adjustBalance(payer, job.subtotal);
  await Promise.all(
    Object.entries(charges).map(([member, amount]) => adjustBalance(member, -amount))
  );

  const id = crypto.randomUUID();
  await addLedgerEntry(id, {
    payer,
    amount: job.subtotal,
    description: "grocery order",
    split: members,
    timestamp: new Date().toISOString(),
  });

  await Promise.all([
    setConfig("last_grocery_run", new Date().toISOString()),
    deleteAllFulfilledGrocery(),
  ]);

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

export function isApprovalMessage(text: string): boolean {
  const t = text.toLowerCase().trim();
  const approved = /^(yes|yeah|yep|yup|go|do it|looks good|go ahead|ok|okay|✓|👍|sounds good)/.test(t);
  const hasEdit = /\b(but|except|drop|remove|change|make it|without|swap|instead)\b/.test(t);
  return approved && !hasEdit;
}

export function isEditMessage(text: string): boolean {
  const t = text.toLowerCase().trim();
  const hasApproval = /(yes|yeah|go|ok|okay|but|drop|remove|change|make it|without|swap)/.test(t);
  const hasEdit = /\b(drop|remove|change|make it|without|swap|instead|except|add)\b/.test(t);
  return hasApproval && hasEdit;
}

export function isCancellationMessage(text: string): boolean {
  const t = text.toLowerCase().trim();
  return /^(no|nope|cancel|stop|don't|never mind|forget it)/.test(t);
}

export function extractOtpCode(text: string): string | null {
  const match = text.match(/\b(\d{4,8})\b/);
  return match ? match[1] : null;
}

export type { OrderJob, OrderCartItem };
