import "./env.js";
import { isConfigured, closeClient } from "./client.js";
import { startListener, stopListener } from "./listener.js";
import { startSender } from "./sender.js";
import { log } from "./log.js";

if (!isConfigured()) {
  log("slack-bridge.disabled", {
    reason:
      "set SLACK_TEAM_ID and SLACK_JWT in .env (mint the JWT from the Photon dashboard), then restart",
  });
  process.exit(0);
}

const server = startSender();
startListener();

async function shutdown(signal: string): Promise<void> {
  log("slack-bridge.shutdown", { signal });
  await stopListener();
  server.close();
  await closeClient();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
