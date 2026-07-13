/** Read-only: prints recent messages for a chatId (arg 1) as JSON lines. */
import "../env.js";
import { sdk } from "../sdk.js";

const chatId = process.argv[2];
if (!chatId) {
  console.error("usage: tsx src/scripts/peek-chat.ts <chatId>");
  process.exit(1);
}
const messages = await sdk.getMessages({ chatId, excludeReactions: true, limit: 10 });
for (const m of messages) {
  console.log(
    JSON.stringify({
      rowId: m.rowId,
      participant: m.participant,
      isFromMe: m.isFromMe,
      text: m.text,
      createdAt: m.createdAt,
    })
  );
}
await sdk.close();
