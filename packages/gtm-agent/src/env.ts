import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** GTM agent package root (packages/gtm-agent). */
export const GTM_AGENT_ROOT = path.resolve(here, "..");

/** Monorepo root .env shared by all services. */
export const ROOT_ENV_PATH = path.resolve(here, "../../../.env");

config({ path: ROOT_ENV_PATH });
config();
