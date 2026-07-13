import "./env.js";
import { createServer } from "node:http";
import { draftPost, fetchTrend } from "./agent.js";
import { isConfigured, postDraft, publishToX } from "./kylon.js";
import { log } from "./log.js";

const PORT = Number(process.env.GTM_AGENT_PORT) || 3003;
const INTERVAL_MS = Math.max(1_000, Number(process.env.GTM_INTERVAL_MS) || 86_400_000);
const AUTOPOST = process.env.GTM_AUTOPOST === "true";
const DEMO = process.env.DEMO_MODE !== "false";
const PRODUCT = process.env.GTM_TREND_PRODUCT || "eggs";
const RUN_ONCE = process.argv.includes("--once");

let running = false;

async function cycle(reason: string): Promise<void> {
  if (running) {
    log("gtm.skip", { reason: "cycle_already_running" });
    return;
  }
  running = true;
  try {
    log("gtm.cycle_start", { reason, product: PRODUCT });
    const trend = await fetchTrend(PRODUCT);
    const post = await draftPost(trend);
    const draft = await postDraft(post);

    if (AUTOPOST && !DEMO) {
      const published = await publishToX(post);
      log("gtm.cycle_done", { draftId: draft.id, publishedUrl: published.url });
    } else {
      log("gtm.cycle_done", {
        draftId: draft.id,
        autopost: AUTOPOST,
        demo: DEMO,
        published: false,
      });
    }
  } catch (err) {
    log("gtm.cycle_failed", { error: String(err) });
  } finally {
    running = false;
  }
}

if (!isConfigured()) {
  log("gtm-agent.disabled", {
    reason: "set KYLON_API_KEY and KYLON_WORKSPACE_ID to create live Kylon drafts",
    demo: DEMO,
  });
  process.exit(0);
}

if (RUN_ONCE) {
  await cycle("manual");
  process.exit(0);
}

const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", service: "hearth-gtm-agent" }));
});

server.listen(PORT, () => {
  log("gtm-agent.started", { port: PORT, intervalMs: INTERVAL_MS, autopost: AUTOPOST, demo: DEMO });
});

void cycle("startup");
const timer = setInterval(() => void cycle("interval"), INTERVAL_MS);

async function shutdown(signal: string): Promise<void> {
  log("gtm-agent.shutdown", { signal });
  clearInterval(timer);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
