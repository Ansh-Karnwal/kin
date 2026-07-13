/**
 * One-time bootstrap for the Telegram group chat:
 *   1. Long-polls for messages — send one in the group after adding the bot —
 *      and captures that group's chat id.
 *   2. Saves it to the root .env as TARGET_CHAT_GUID.
 *   3. As each person sends a message, prompts for their name and builds the
 *      handle map (Telegram user id → name) in bridge/handles.json, then seeds
 *      the agent's member list.
 *
 * Run with: npm run setup -w packages/bridge
 */
import "../env.js";
import fs from "node:fs";
import readline from "node:readline/promises";
import { ROOT_ENV_PATH } from "../env.js";
import { getUpdates, deleteWebhook } from "../telegram.js";
import { saveHandles, HANDLES_PATH, type HandleMap } from "../handles.js";

const AGENT_PORT = Number(process.env.AGENT_PORT) || 3000;

function upsertEnvVar(key: string, value: string): void {
  const existing = fs.existsSync(ROOT_ENV_PATH)
    ? fs.readFileSync(ROOT_ENV_PATH, "utf8")
    : "";
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, "m");
  const updated = pattern.test(existing)
    ? existing.replace(pattern, line)
    : `${existing.replace(/\n*$/, "\n")}${line}\n`;
  fs.writeFileSync(ROOT_ENV_PATH, updated, "utf8");
}

async function seedMembers(members: string[]): Promise<void> {
  try {
    const res = await fetch(`http://localhost:${AGENT_PORT}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ members }),
    });
    if (res.ok) {
      console.log(`seeded agent members: ${members.join(", ")}`);
    } else {
      console.warn(`agent rejected members (HTTP ${res.status})`);
    }
  } catch {
    console.warn(
      `agent not reachable on port ${AGENT_PORT} — start it and POST {"members": [...]} to /members yourself, or re-run setup`
    );
  }
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    await deleteWebhook();
    console.log(
      [
        "add the bot to your Telegram group, then send a message in it.",
        "waiting for the first message…",
        "(once the group is captured, have each person send a message so you",
        " can label them. type 'done' when everyone's been added.)\n",
      ].join("\n")
    );

    let chatId: string | null = null;
    const handles: HandleMap = {};
    // Start from "now" so we don't replay stale updates from before setup.
    let offset = 0;
    const firstBatch = await getUpdates(0, 0);
    if (firstBatch.length > 0) offset = firstBatch[firstBatch.length - 1]!.update_id + 1;

    poll: for (;;) {
      const updates = await getUpdates(offset, 30);
      for (const update of updates) {
        offset = update.update_id + 1;
        const message = update.message;
        if (!message?.text || !message.from || message.from.is_bot) continue;

        const senderId = String(message.from.id);
        const msgChatId = String(message.chat.id);

        if (!chatId) {
          chatId = msgChatId;
          upsertEnvVar("TARGET_CHAT_GUID", chatId);
          console.log(`\ncaptured group chat id: ${chatId}`);
          console.log(`saved TARGET_CHAT_GUID=${chatId} to ${ROOT_ENV_PATH}\n`);
        } else if (msgChatId !== chatId) {
          continue;
        }

        if (handles[senderId]) continue; // already labeled

        const who = message.from.first_name ? ` (${message.from.first_name})` : "";
        console.log(`new sender ${senderId}${who} said: "${message.text}"`);
        const name = (await rl.question("  what's their name? (or 'done' to finish): ")).trim();
        if (name.toLowerCase() === "done") break poll;
        if (!name) {
          console.log("  skipped — they'll show by their Telegram name until labeled.");
          continue;
        }
        handles[senderId] = name;
        saveHandles(handles);
        console.log(`  saved ${senderId} → ${name}`);
      }
    }

    const members = [...new Set(Object.values(handles))];
    if (members.length > 0) {
      console.log(`\nsaved handle map to ${HANDLES_PATH}`);
      await seedMembers(members);
    } else {
      console.log("no members labeled — skipping handle map and member seeding.");
    }

    console.log("\ndone. start everything with: npm run dev");
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error("setup failed:", err);
  process.exitCode = 1;
});
