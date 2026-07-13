// ── InsForge provisioning ──────────────────────────────────────────────────────
//
// The agent-native pitch: Kin stands up its own backend. This script idempotently
// creates the 13 Postgres tables db.ts operates on plus the receipt storage
// bucket, so a fresh InsForge project is demo-ready in one command:
//
//   npm run provision -w packages/agent
//
// It is safe to re-run — "already exists" responses are treated as success. If
// your InsForge deployment mounts its schema/storage APIs at different paths,
// adjust the constants below (they mirror db.ts).
//
// Requires INSFORGE_URL + INSFORGE_API_KEY. Without them the script exits early
// (nothing to provision — the app runs on Butterbase or in-memory state).

import "../env.js";
import { log } from "../log.js";
import { INSFORGE_URL, INSFORGE_API_KEY, INSFORGE_BUCKET, USE_INSFORGE } from "../db.js";

const TABLES_PATH = "/api/database/tables";
const BUCKETS_PATH = "/api/storage/buckets";

type Col = {
  name: string;
  type: "uuid" | "text" | "numeric" | "integer" | "boolean" | "timestamptz" | "date" | "jsonb";
  primaryKey?: boolean;
  nullable?: boolean;
  default?: string; // raw SQL default, e.g. "now()", "gen_random_uuid()", "false"
};

function idCol(): Col {
  return { name: "id", type: "uuid", primaryKey: true, default: "gen_random_uuid()" };
}

// Columns match the snake_case row shapes db.ts reads/writes. Timestamp columns
// the code doesn't set on insert (added_at, created_at, updated_at) default to now().
const TABLES: Record<string, Col[]> = {
  members: [
    idCol(),
    { name: "name", type: "text" },
    { name: "balance", type: "numeric", default: "0" },
  ],
  household_facts: [
    idCol(),
    { name: "key", type: "text" },
    { name: "value", type: "text", nullable: true },
  ],
  household_config: [
    idCol(),
    { name: "key", type: "text" },
    { name: "value", type: "text", nullable: true },
  ],
  grocery_items: [
    idCol(),
    { name: "item", type: "text" },
    { name: "requested_by", type: "text" },
    { name: "added_at", type: "timestamptz", default: "now()" },
    { name: "fulfilled", type: "boolean", default: "false" },
  ],
  ledger_entries: [
    idCol(),
    { name: "payer", type: "text" },
    { name: "amount", type: "numeric" },
    { name: "description", type: "text", nullable: true },
    { name: "split", type: "jsonb", default: "'[]'" },
    { name: "timestamp", type: "timestamptz", default: "now()" },
    { name: "receipt_url", type: "text", nullable: true },
  ],
  pending_items: [
    idCol(),
    { name: "description", type: "text" },
    { name: "raised_by", type: "text" },
    { name: "raised_at", type: "timestamptz", default: "now()" },
    { name: "deadline", type: "timestamptz", nullable: true },
    { name: "resolved", type: "boolean", default: "false" },
    { name: "resolved_at", type: "timestamptz", nullable: true },
    { name: "resolved_by", type: "text", nullable: true },
  ],
  maintenance_issues: [
    idCol(),
    { name: "description", type: "text" },
    { name: "reported_by", type: "text" },
    { name: "status", type: "text" },
    { name: "priority", type: "text" },
    { name: "first_seen_at", type: "timestamptz", default: "now()" },
    { name: "last_updated_at", type: "timestamptz", default: "now()" },
    { name: "resolution_notes", type: "text", nullable: true },
    { name: "landlord_notified_at", type: "timestamptz", nullable: true },
    { name: "scheduled_for", type: "timestamptz", nullable: true },
    { name: "vendor", type: "text", nullable: true },
    { name: "photo_urls", type: "jsonb", default: "'[]'" },
  ],
  house_events: [
    idCol(),
    { name: "title", type: "text" },
    { name: "event_date", type: "date" },
    { name: "event_time", type: "text", nullable: true },
    { name: "duration_minutes", type: "integer", nullable: true },
    { name: "all_day", type: "boolean", default: "false" },
    { name: "created_by", type: "text" },
    { name: "affects_members", type: "jsonb", default: "'[]'" },
    { name: "event_type", type: "text" },
    { name: "notes", type: "text", nullable: true },
    { name: "created_at", type: "timestamptz", default: "now()" },
  ],
  consumption_patterns: [
    idCol(),
    { name: "item_name", type: "text" },
    { name: "avg_days_between_orders", type: "numeric", nullable: true },
    { name: "last_ordered_at", type: "timestamptz", nullable: true },
    { name: "times_ordered", type: "integer", default: "0" },
    { name: "typical_requesters", type: "jsonb", default: "'[]'" },
    { name: "updated_at", type: "timestamptz", default: "now()" },
  ],
  order_jobs: [
    idCol(),
    { name: "chat_id", type: "text" },
    { name: "status", type: "text" },
    { name: "items", type: "jsonb", default: "'[]'" },
    { name: "session_id", type: "text", nullable: true },
    { name: "cart", type: "jsonb", nullable: true },
    { name: "subtotal", type: "numeric", nullable: true },
    { name: "note", type: "text", nullable: true },
    { name: "created_at", type: "timestamptz", default: "now()" },
    { name: "updated_at", type: "timestamptz", default: "now()" },
  ],
  move_events: [
    idCol(),
    { name: "chat_id", type: "text" },
    { name: "type", type: "text" },
    { name: "member", type: "text" },
    { name: "phase", type: "text" },
    { name: "target_date", type: "date", nullable: true },
    { name: "deposit_amount", type: "numeric", nullable: true },
    { name: "deposit_deductions", type: "jsonb", default: "'[]'" },
    { name: "shared_assets", type: "jsonb", default: "'[]'" },
    { name: "utility_transfer_status", type: "jsonb", default: "'{}'" },
    { name: "final_balance", type: "numeric", nullable: true },
    { name: "created_at", type: "timestamptz", default: "now()" },
    { name: "updated_at", type: "timestamptz", default: "now()" },
  ],
  utility_accounts: [
    idCol(),
    { name: "name", type: "text" },
    { name: "login_url", type: "text", nullable: true },
    { name: "context_id", type: "text", nullable: true },
    { name: "account_holder", type: "text", nullable: true },
    { name: "autopay_enabled", type: "boolean", default: "false" },
    { name: "alert_threshold_pct", type: "numeric", default: "15" },
    { name: "created_at", type: "timestamptz", default: "now()" },
  ],
  utility_bills: [
    idCol(),
    { name: "account_id", type: "text" },
    { name: "amount", type: "numeric" },
    { name: "due_date", type: "date", nullable: true },
    { name: "period_start", type: "date", nullable: true },
    { name: "period_end", type: "date", nullable: true },
    { name: "status", type: "text" },
    { name: "fetched_at", type: "timestamptz", default: "now()" },
  ],
};

function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${INSFORGE_API_KEY}`,
  };
}

/** Treat 2xx and any "already exists" style conflict as success. */
function isAlreadyExists(status: number, body: string): boolean {
  if (status === 409) return true;
  const b = body.toLowerCase();
  return (status === 400 || status === 422) && (b.includes("already exists") || b.includes("duplicate"));
}

async function ensureTable(name: string, columns: Col[]): Promise<void> {
  const res = await fetch(`${INSFORGE_URL}${TABLES_PATH}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ table_name: name, name, columns }),
  });
  const body = await res.text();
  if (res.ok) {
    log("provision.table_created", { table: name, columns: columns.length });
  } else if (isAlreadyExists(res.status, body)) {
    log("provision.table_exists", { table: name });
  } else {
    throw new Error(`create table ${name} → ${res.status}: ${body}`);
  }
}

async function ensureBucket(name: string): Promise<void> {
  const res = await fetch(`${INSFORGE_URL}${BUCKETS_PATH}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ name, bucket_name: name, public: true }),
  });
  const body = await res.text();
  if (res.ok) {
    log("provision.bucket_created", { bucket: name });
  } else if (isAlreadyExists(res.status, body)) {
    log("provision.bucket_exists", { bucket: name });
  } else {
    throw new Error(`create bucket ${name} → ${res.status}: ${body}`);
  }
}

async function main(): Promise<void> {
  if (!USE_INSFORGE) {
    log("provision.skipped", { reason: "INSFORGE_URL / INSFORGE_API_KEY not set" });
    console.warn(
      "InsForge is not configured — set INSFORGE_URL and INSFORGE_API_KEY in .env to provision. Nothing to do."
    );
    return;
  }

  log("provision.start", { url: INSFORGE_URL, tables: Object.keys(TABLES).length, bucket: INSFORGE_BUCKET });

  for (const [name, columns] of Object.entries(TABLES)) {
    await ensureTable(name, columns);
  }
  await ensureBucket(INSFORGE_BUCKET);

  log("provision.done", { tables: Object.keys(TABLES).length, bucket: INSFORGE_BUCKET });
  console.log(`✓ provisioned ${Object.keys(TABLES).length} tables + bucket "${INSFORGE_BUCKET}" on InsForge`);
}

main().catch((err) => {
  log("provision.failed", { error: String(err) });
  console.error(err);
  process.exit(1);
});
