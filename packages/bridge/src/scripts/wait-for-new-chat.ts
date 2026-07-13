/**
 * Read-only: polls chat.db until a group chat with activity newer than the
 * script's start time appears, then prints it as JSON. Used by setup to
 * detect a freshly created household chat. Exits 1 on timeout.
 */
import "../env.js";
import { sdk } from "../sdk.js";

const startedAt = new Date();
const TIMEOUT_MS = 5 * 60 * 1_000;
const POLL_MS = 5_000;

const deadline = Date.now() + TIMEOUT_MS;
while (Date.now() < deadline) {
  const chats = await sdk.listChats({ kind: "group", sortBy: "recent", limit: 5 });
  const fresh = chats.find((c) => c.lastMessageAt !== null && c.lastMessageAt > startedAt);
  if (fresh) {
    console.log(JSON.stringify({ name: fresh.name, chatId: fresh.chatId, lastMessageAt: fresh.lastMessageAt }));
    await sdk.close();
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
console.error("timed out waiting for a new group chat");
await sdk.close();
process.exit(1);
