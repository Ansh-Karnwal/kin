import fs from "node:fs";
import path from "node:path";
import { SLACK_BRIDGE_ROOT } from "./env.js";
import { log } from "./log.js";

/** Maps Slack user ids to roommate names, e.g. "U0123456789" → "Jake". */
export type HandleMap = Record<string, string>;

export const HANDLES_PATH = path.join(SLACK_BRIDGE_ROOT, "slack-handles.json");

export function loadHandles(): HandleMap {
  try {
    const raw = fs.readFileSync(HANDLES_PATH, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("slack-handles.json must be an object of user id → name");
    }
    const map: HandleMap = {};
    for (const [id, name] of Object.entries(parsed)) {
      if (typeof name === "string") map[id] = name;
    }
    return map;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log("handles.load_failed", { path: HANDLES_PATH, error: String(err) });
    }
    return {};
  }
}

/** Resolve a Slack user id to a roommate name, falling back to the raw id. */
export function resolveSender(handles: HandleMap, userId: string): string {
  return handles[userId] ?? userId;
}
