import { text, type TypedEventStream, type SlackEvent } from "@photon-ai/slack";
import { getTeam } from "./client.js";
import { loadHandles, resolveSender } from "./handles.js";
import { log } from "./log.js";

const AGENT_PORT = Number(process.env.AGENT_PORT) || 3000;
const TARGET_CHANNEL = process.env.TARGET_SLACK_CHANNEL ?? "";

interface AgentReply {
  reply: string | null;
}

async function forwardToAgent(sender: string, body: string, channel: string): Promise<void> {
  const res = await fetch(`http://localhost:${AGENT_PORT}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender, text: body, chatId: channel }),
  });
  if (!res.ok) {
    log("listener.agent_error", { status: res.status, sender });
    return;
  }
  const { reply } = (await res.json()) as AgentReply;
  if (reply === null || reply === undefined) {
    log("listener.no_reply", { sender });
    return;
  }
  await getTeam().messages.send({ channel, ...text(reply) });
  log("send.outbound", { channel, message: reply });
}

/**
 * Agent state is in-memory until Phase 7, so member names must be re-seeded
 * on every agent start. Retries while the agent boots under `concurrently`.
 */
async function seedMembers(): Promise<void> {
  const members = [...new Set(Object.values(loadHandles()))];
  if (members.length === 0) return;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(`http://localhost:${AGENT_PORT}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ members }),
      });
      if (res.ok) {
        log("listener.members_seeded", { members });
      } else {
        log("listener.members_seed_rejected", { status: res.status });
      }
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 2_000 * attempt));
    }
  }
  log("listener.members_seed_failed", { reason: "agent unreachable" });
}

let stream: TypedEventStream<SlackEvent> | null = null;

export function startListener(): void {
  if (!TARGET_CHANNEL) {
    log("listener.disabled", { reason: "TARGET_SLACK_CHANNEL not set" });
    return;
  }

  const team = getTeam();
  void seedMembers();
  log("listener.started", { teamId: team.teamId, channel: TARGET_CHANNEL });

  stream = team.events.subscribe();
  void (async () => {
    try {
      for await (const event of stream) {
        // "mention" events duplicate the "message" event for @-mentions of
        // the bot, and reactions/commands/interactives aren't chat traffic.
        if (event.type !== "message") continue;
        const m = event.message;
        if (m.channel !== TARGET_CHANNEL) continue;
        if (m.isFromMe) continue; // server-stamped — the bot's own posts
        if (m.subtype) continue; // edits, deletes, joins — not new messages
        if (!m.text) continue;

        const sender = resolveSender(loadHandles(), m.user);
        log("listener.inbound", { sender, user: m.user, channel: m.channel, text: m.text });
        try {
          await forwardToAgent(sender, m.text, m.channel);
        } catch (err) {
          log("listener.forward_failed", { sender, error: String(err) });
        }
      }
      log("listener.stream_ended", {});
    } catch (err) {
      log("listener.stream_error", { error: String(err) });
    }
  })();
}

export async function stopListener(): Promise<void> {
  if (stream) {
    await stream[Symbol.asyncDispose]();
    stream = null;
  }
}
