import { spawn } from "node:child_process";
import { log } from "./log.js";

const DEMO = process.env.DEMO_MODE !== "false";
const BASE = (process.env.KYLON_API_BASE || "https://api.kylon.io").replace(/\/+$/, "");
const KEY = process.env.KYLON_API_KEY || process.env.KYLON_WORKSPACE_API_KEY || "";
const WORKSPACE_ID = process.env.KYLON_WORKSPACE_ID || "";
const CHANNEL_ID = process.env.KYLON_CHANNEL_ID || "";

const DRAFT_TOOL = process.env.KYLON_DRAFT_TOOL || "";
const DRAFT_CONNECTION_ID = process.env.KYLON_DRAFT_CONNECTION_ID || "";
const X_TOOL = process.env.KYLON_X_TOOL || "X_CREATE_POST";
const X_CONNECTION_ID = process.env.KYLON_X_CONNECTION_ID || "";

export function isConfigured(): boolean {
  return !!KEY && !!WORKSPACE_ID;
}

function headers(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": KEY,
  };
}

async function executeTool<T>(
  tool: string,
  args: Record<string, unknown>,
  connectionId?: string
): Promise<T> {
  const res = await fetch(`${BASE}/proxy/tools/execute`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      tool,
      arguments: args,
      ...(connectionId ? { connection_id: connectionId } : {}),
    }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    data?: T;
    error?: string | null;
    successful?: boolean;
  };
  if (!res.ok || data.successful === false) {
    throw new Error(`kylon tool ${tool} failed: ${data.error ?? res.statusText}`);
  }
  return data.data as T;
}

async function runKylonCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("kylon", args, {
      env: {
        ...process.env,
        KYLON_WORKSPACE_API_URL: BASE,
        KYLON_WORKSPACE_ID: WORKSPACE_ID,
        KYLON_WORKSPACE_API_KEY: KEY,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `kylon exited ${code}`));
    });
  });
}

function idFrom(value: unknown): string {
  if (typeof value === "string" && value) return value;
  if (typeof value === "object" && value !== null) {
    const r = value as Record<string, unknown>;
    for (const key of ["id", "messageId", "message_id", "threadId", "url"]) {
      const v = r[key];
      if (typeof v === "string" && v) return v;
    }
  }
  return `sim_${crypto.randomUUID()}`;
}

export async function postDraft(text: string): Promise<{ id: string }> {
  if (DEMO || !isConfigured()) {
    const id = `demo_draft_${crypto.randomUUID()}`;
    log("kylon.draft_simulated", { id, workspaceId: WORKSPACE_ID || null, text });
    return { id };
  }

  if (DRAFT_TOOL) {
    const data = await executeTool<unknown>(
      DRAFT_TOOL,
      {
        workspace_id: WORKSPACE_ID,
        channel_id: CHANNEL_ID || undefined,
        text,
        body: text,
        title: "Kin GTM draft",
        status: "draft",
      },
      DRAFT_CONNECTION_ID || undefined
    );
    const id = idFrom(data);
    log("kylon.draft_posted", { id, via: "tools_api", tool: DRAFT_TOOL });
    return { id };
  }

  if (CHANNEL_ID) {
    const out = await runKylonCli([
      "workspace",
      "message",
      "send",
      "--scope-workspace",
      WORKSPACE_ID,
      "--channel",
      CHANNEL_ID,
      "--text",
      `draft for approval:\n\n${text}`,
    ]);
    const id = out || `cli_${crypto.randomUUID()}`;
    log("kylon.draft_posted", { id, via: "cli" });
    return { id };
  }

  const id = `local_draft_${crypto.randomUUID()}`;
  log("kylon.draft_local_only", {
    id,
    reason: "set KYLON_DRAFT_TOOL or KYLON_CHANNEL_ID to create a live Kylon draft",
    text,
  });
  return { id };
}

export async function publishToX(text: string): Promise<{ url: string }> {
  if (DEMO || !isConfigured()) {
    const url = `https://x.com/kin/status/demo-${crypto.randomUUID()}`;
    log("kylon.x_simulated", { url, text });
    return { url };
  }

  const data = await executeTool<unknown>(
    X_TOOL,
    { text, body: text, content: text, workspace_id: WORKSPACE_ID },
    X_CONNECTION_ID || undefined
  );
  const url = idFrom(data);
  log("kylon.x_published", { url, tool: X_TOOL });
  return { url };
}
