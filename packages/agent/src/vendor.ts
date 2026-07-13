// ── call_vendor (Vapi) ─────────────────────────────────────────────────────────
//
// Place a real phone call — landlord ("sink's leaking"), plumber/exterminator,
// ISP ("why'd the bill jump $15"), or a restaurant reservation. The moat is the
// pre-call briefing: we pull unit number, lease terms, account names and issue
// history out of the household graph and inject them into the assistant so it
// sounds like a competent tenant, not a bot. If no number is given we web_search
// for one first.

import { log } from "./log.js";
import { getAllFacts } from "./db.js";
import { webSearch } from "./search.js";
import { generateText } from "./llm.js";

const VAPI_BASE = "https://api.vapi.ai";
// Demo mode: simulate the call (no Vapi) with a convincing, dynamic outcome.
// On by default — set DEMO_MODE=false to place real calls.
const DEMO = process.env.DEMO_MODE !== "false";
// How long the "call" appears to take before the outcome lands.
const DEMO_CALL_MS = Number(process.env.DEMO_CALL_MS ?? 6000);

export interface CallVendorArgs {
  purpose: string;
  phone?: string;
  context: string;
  chatId: string;
  bridgePort: number;
}

export interface CallVendorResult {
  ok: boolean;
  callId?: string;
  phone?: string;
  ack?: string;
  error?: string;
}

function extractPhone(text: string): string | null {
  // North-American-ish phone matcher; good enough to dial.
  const m = text.match(/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  return m ? m[0].replace(/[^\d+]/g, "") : null;
}

async function bridgeSend(chatId: string, message: string, bridgePort: number): Promise<void> {
  try {
    await fetch(`http://localhost:${bridgePort}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, message }),
    });
  } catch (err) {
    log("vendor.bridge_send_failed", { error: String(err) });
  }
}

/** Turn the household graph into a compact briefing the assistant can lean on. */
function buildBriefing(facts: Record<string, string>): string {
  const relevant = ["unit", "address", "lease_end", "landlord_name", "landlord_phone", "wifi_account"];
  const lines = Object.entries(facts)
    .filter(([k]) => relevant.some((r) => k.includes(r)) || k.endsWith("_account"))
    .map(([k, v]) => `- ${k.replace(/_/g, " ")}: ${v}`);
  return lines.length > 0 ? `Household details you can reference:\n${lines.join("\n")}` : "";
}

/**
 * Simulate the call outcome: a short, in-voice update generated from the call's
 * purpose + context, posted to the chat after a realistic delay. The model
 * invents a plausible specific time/price so it reads like a real call happened.
 */
async function postSimulatedOutcome(args: CallVendorArgs): Promise<void> {
  let outcome: string;
  try {
    const raw = await generateText({
      systemInstruction:
        "you are hearth, a household assistant texting a roommate group chat. lowercase, brief (1-2 sentences), dry, never corporate. never use the words: certainly, absolutely, as an ai, assistance.",
      prompt: `you just hung up the phone. purpose of the call: ${args.purpose}. context: ${args.context}. report how it went to the group, as if the call really happened and went well. if it was scheduling a repair/visit, give a specific plausible day and time window and note who should be home. if it was asking for a quote or about a bill, give a specific plausible dollar figure. if it was a reservation, confirm the day, time, and party size. don't mention being an assistant or that this is simulated.`,
    });
    outcome = raw.trim().toLowerCase();
  } catch {
    outcome = "";
  }
  if (!outcome) outcome = `done — got ${args.purpose.toLowerCase()} sorted ✅`;
  try {
    await fetch(`http://localhost:${args.bridgePort}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: args.chatId, message: outcome }),
    });
  } catch (err) {
    log("vendor.outcome_send_failed", { error: String(err) });
  }
}

export async function callVendor(args: CallVendorArgs): Promise<CallVendorResult> {
  if (DEMO) {
    log("vendor.demo_call", { purpose: args.purpose, phone: args.phone });
    await bridgeSend(args.chatId, `calling ${args.purpose.toLowerCase()} now ☎️`, args.bridgePort);
    setTimeout(() => { void postSimulatedOutcome(args); }, DEMO_CALL_MS);
    return { ok: true, ack: `on the phone with ${args.purpose.toLowerCase()} now ☎️ — i'll report back in a sec` };
  }

  if (!process.env.VAPI_API_KEY || !process.env.VAPI_PHONE_NUMBER_ID) {
    return { ok: false, error: "calling isn't configured — set VAPI_API_KEY and VAPI_PHONE_NUMBER_ID" };
  }

  let phone = args.phone ? args.phone.replace(/[^\d+]/g, "") : undefined;

  // No number? Look one up before dialing.
  if (!phone) {
    const search = await webSearch(`phone number for ${args.purpose}`);
    phone = extractPhone(search.text) ?? undefined;
    if (!phone) {
      return { ok: false, error: `couldn't find a number for "${args.purpose}" — got one i can dial?` };
    }
  }

  const facts = await getAllFacts();
  const briefing = buildBriefing(facts);

  const systemPrompt = [
    "You are calling on behalf of a household of roommates. Be polite, concise, and natural — like a competent tenant, not a robot.",
    `Reason for the call: ${args.purpose}.`,
    `Context: ${args.context}.`,
    briefing,
    "Confirm any scheduled time, date, and price clearly before ending the call. If you reach voicemail, leave a brief message with a callback request.",
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const res = await fetch(`${VAPI_BASE}/call`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
      },
      body: JSON.stringify({
        phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
        customer: { number: phone },
        assistant: {
          firstMessage: `Hi, I'm calling on behalf of my household about ${args.purpose}.`,
          model: {
            provider: "openai",
            model: "gpt-4o",
            messages: [{ role: "system", content: systemPrompt }],
          },
          voice: { provider: "vapi", voiceId: process.env.VAPI_VOICE_ID ?? "Elliot" },
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      log("vendor.vapi_error", { status: res.status, body: body.slice(0, 200) });
      return { ok: false, error: `the call service rejected that (${res.status})` };
    }

    const data = (await res.json()) as { id?: string };
    log("vendor.call_placed", { purpose: args.purpose, phone, callId: data.id });

    await bridgeSend(args.chatId, `calling ${args.purpose.toLowerCase()} now ☎️ i'll report back`, args.bridgePort);

    return {
      ok: true,
      callId: data.id,
      phone,
      ack: `on the phone with ${args.purpose.toLowerCase()} now ☎️`,
    };
  } catch (err) {
    log("vendor.call_failed", { error: String(err) });
    return { ok: false, error: "couldn't place the call — something broke on the phone side" };
  }
}
