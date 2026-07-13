import fs from "node:fs";
import path from "node:path";
import { BRIDGE_ROOT } from "./env.js";
import { log } from "./log.js";

/** Maps Telegram user ids to roommate names, e.g. "123456789" → "Jake". */
export type HandleMap = Record<string, string>;

export const HANDLES_PATH = path.join(BRIDGE_ROOT, "handles.json");

export function loadHandles(): HandleMap {
  try {
    const raw = fs.readFileSync(HANDLES_PATH, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("handles.json must be an object of handle → name");
    }
    const map: HandleMap = {};
    for (const [handle, name] of Object.entries(parsed)) {
      if (typeof name === "string") map[handle] = name;
    }
    return map;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log("handles.load_failed", { path: HANDLES_PATH, error: String(err) });
    }
    return {};
  }
}

export function saveHandles(map: HandleMap): void {
  fs.writeFileSync(HANDLES_PATH, `${JSON.stringify(map, null, 2)}\n`, "utf8");
}

/**
 * Resolve a Telegram user id to a roommate name. Prefer an explicit mapping
 * from handles.json; otherwise fall back to the sender's Telegram first name,
 * and finally the raw id. The fallback means people are recognizable even
 * before they're labeled in setup.
 */
export function resolveSender(
  handles: HandleMap,
  userId: string,
  firstName?: string
): string {
  return handles[userId] ?? firstName ?? userId;
}
