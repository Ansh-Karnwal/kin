import "./env.js";
import { startListener, stopListener } from "./listener.js";
import { startSender } from "./sender.js";
import { sdk } from "./sdk.js";
import { log } from "./log.js";

const server = startSender();
startListener();

async function shutdown(signal: string): Promise<void> {
  log("bridge.shutdown", { signal });
  stopListener();
  server.close();
  await sdk.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
