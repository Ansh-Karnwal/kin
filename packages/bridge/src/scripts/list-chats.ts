/** Read-only: prints recent group chats as JSON lines. Used to verify DB access. */
import "../env.js";
import { sdk } from "../sdk.js";

const chats = await sdk.listChats({ kind: "group", sortBy: "recent", limit: 10 });
for (const c of chats) {
  console.log(JSON.stringify({ name: c.name, chatId: c.chatId, lastMessageAt: c.lastMessageAt }));
}
await sdk.close();
