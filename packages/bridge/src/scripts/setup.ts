/**
 * One-time bootstrap:
 *   1. Lists recent group chats so you can identify the household chat.
 *   2. Saves its chatId to the root .env as TARGET_CHAT_GUID.
 *   3. Prompts for roommate names + phone numbers, saves the handle map
 *      (bridge/handles.json) and seeds the agent's member list.
 *
 * Run with: npm run setup -w packages/bridge
 */
import "../env.js";
import fs from "node:fs";
import readline from "node:readline/promises";
import { ROOT_ENV_PATH } from "../env.js";
// Importing the shared instance also gives us the friendly Full Disk Access
// error on creation failure, instead of a raw stack trace.
import { sdk } from "../sdk.js";
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
    console.log("fetching recent group chats…\n");
    const chats = await sdk.listChats({ kind: "group", sortBy: "recent", limit: 20 });

    if (chats.length === 0) {
      console.error(
        "no group chats found. Is iMessage set up, and does your terminal have Full Disk Access (System Settings → Privacy & Security)?"
      );
      return;
    }

    chats.forEach((chat, i) => {
      const last = chat.lastMessageAt ? chat.lastMessageAt.toLocaleString() : "never";
      console.log(`  [${i + 1}] ${chat.name ?? "(unnamed)"} — ${chat.chatId} (last message: ${last})`);
    });

    const pick = await rl.question("\nwhich one is the household chat? (number): ");
    const index = Number.parseInt(pick.trim(), 10) - 1;
    const chosen = chats[index];
    if (!chosen) {
      console.error(`invalid selection: ${pick}`);
      return;
    }

    upsertEnvVar("TARGET_CHAT_GUID", chosen.chatId);
    console.log(`\nsaved TARGET_CHAT_GUID=${chosen.chatId} to ${ROOT_ENV_PATH}\n`);

    console.log("now the roommates. enter one per line as `Name, +15551234567` — blank line to finish.");
    const handles: HandleMap = {};
    const members: string[] = [];
    for (;;) {
      const answer = (await rl.question("> ")).trim();
      if (!answer) break;
      const comma = answer.indexOf(",");
      if (comma === -1) {
        console.log("  format is `Name, phone` — try again");
        continue;
      }
      const name = answer.slice(0, comma).trim();
      const phone = answer.slice(comma + 1).trim();
      if (!name || !phone) {
        console.log("  format is `Name, phone` — try again");
        continue;
      }
      handles[phone] = name;
      members.push(name);
    }

    if (members.length > 0) {
      saveHandles(handles);
      console.log(`\nsaved handle map to ${HANDLES_PATH}`);
      await seedMembers(members);
    } else {
      console.log("no roommates entered — skipping handle map and member seeding.");
    }

    console.log("\ndone. start everything with: npm run dev");
  } finally {
    rl.close();
    await sdk.close();
  }
}

main().catch((err) => {
  console.error("setup failed:", err);
  process.exitCode = 1;
});
