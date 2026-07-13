import { config } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

// Load the monorepo root .env first (workspace scripts run with the package as
// cwd, so a bare dotenv/config would miss it), then any package-local .env.
config({ path: path.resolve(here, "../../../.env") });
config();
