import fs from "node:fs";
import path from "node:path";
import {
  createClient,
  staticTokens,
  type CursorStore,
  type SlackClient,
  type TeamClient,
} from "@photon-ai/slack";
import { SLACK_BRIDGE_ROOT } from "./env.js";
import { log } from "./log.js";

export const TEAM_ID = process.env.SLACK_TEAM_ID ?? "";
const JWT = process.env.SLACK_JWT ?? "";

/** Survives restarts so the event stream resumes where it left off. */
const CURSOR_PATH = path.join(SLACK_BRIDGE_ROOT, ".cursor");

function fileCursorStore(): CursorStore {
  return {
    get(teamId) {
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(CURSOR_PATH, "utf8"));
        const cursor = (parsed as Record<string, unknown>)[teamId];
        return typeof cursor === "string" ? cursor : undefined;
      } catch {
        return undefined;
      }
    },
    set(teamId, cursor) {
      fs.writeFileSync(CURSOR_PATH, `${JSON.stringify({ [teamId]: cursor })}\n`, "utf8");
    },
  };
}

export function isConfigured(): boolean {
  return TEAM_ID.length > 0 && JWT.length > 0;
}

let client: SlackClient | null = null;

/** Lazy so the bridge can start (and explain itself) without credentials. */
export function getTeam(): TeamClient {
  if (!isConfigured()) {
    log("slack.not_configured", {
      reason: "SLACK_TEAM_ID / SLACK_JWT missing from .env",
    });
    throw new Error("slack bridge not configured");
  }
  client ??= createClient({
    tokenProvider: staticTokens({ tokens: { [TEAM_ID]: JWT } }),
    cursorStore: fileCursorStore(),
  });
  return client.team(TEAM_ID);
}

export async function closeClient(): Promise<void> {
  if (client) await client.close();
  client = null;
}
