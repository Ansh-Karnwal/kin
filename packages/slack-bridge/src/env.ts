import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Slack bridge package root (packages/slack-bridge). */
export const SLACK_BRIDGE_ROOT = path.resolve(here, "..");

/** Monorepo root .env — shared by all services. */
export const ROOT_ENV_PATH = path.resolve(here, "../../../.env");

// Load the monorepo root .env first (workspace scripts run with the package as
// cwd, so a bare dotenv/config would miss it), then any package-local .env.
config({ path: ROOT_ENV_PATH });
config();
