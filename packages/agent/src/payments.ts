// ── request_payment ───────────────────────────────────────────────────────────
//
// Settle-up that actually happens in the chat: build a Venmo charge deeplink so
// the debtor can pay with one tap. Cheap and reliable — preferred over browser
// bill-pay for roommate-to-roommate money. Handles are recalled from the graph
// (`<name>_venmo`); we fall back to the bare name so the link still resolves.

import { log } from "./log.js";
import { money } from "./state.js";
import { getAllFacts } from "./db.js";

export interface RequestPaymentArgs {
  from: string; // who should pay
  to: string; // who gets paid
  amount: number;
  reason: string;
}

export interface RequestPaymentResult {
  link: string;
  message: string;
}

function slugHandle(name: string, facts: Record<string, string>): string {
  const key = name.toLowerCase().trim();
  return facts[`${key}_venmo`] ?? key.replace(/\s+/g, "-");
}

export async function requestPayment(args: RequestPaymentArgs): Promise<RequestPaymentResult> {
  const facts = await getAllFacts();
  const payerHandle = slugHandle(args.from, facts);
  const note = encodeURIComponent(args.reason || "settle up");

  // Venmo charge deeplink: the payee charges the payer's handle.
  const link = `https://venmo.com/${payerHandle}?txn=charge&amount=${args.amount.toFixed(2)}&note=${note}`;

  log("payment.requested", { from: args.from, to: args.to, amount: args.amount });

  return {
    link,
    message: `${args.from.toLowerCase()}, you owe ${args.to.toLowerCase()} ${money(args.amount)} for ${args.reason} — tap to pay: ${link}`,
  };
}
