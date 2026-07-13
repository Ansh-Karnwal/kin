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

const RAW_SQL_PATH = "/api/database/advance/rawsql";
const BUCKETS_PATH = "/api/storage/buckets";

const TABLE_NAMES = [
  "members",
  "household_facts",
  "household_config",
  "grocery_items",
  "ledger_entries",
  "pending_items",
  "maintenance_issues",
  "house_events",
  "consumption_patterns",
  "order_jobs",
  "move_events",
  "utility_accounts",
  "utility_bills",
];

// Columns match the snake_case row shapes db.ts reads/writes. Array/object fields
// are JSONB because InsForge runs on Postgres/PostgREST; db.ts remains tolerant of
// the legacy stringified shape used by the Butterbase fallback.
const SCHEMA_SQL = `
create extension if not exists pgcrypto;

create table if not exists members (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  balance numeric not null default 0,
  auth_user_id text unique,
  email text,
  created_at timestamptz not null default now()
);

create table if not exists household_facts (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  value text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists household_config (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  value text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists grocery_items (
  id uuid primary key default gen_random_uuid(),
  item text not null,
  requested_by text not null,
  added_at timestamptz not null default now(),
  fulfilled boolean not null default false
);

create table if not exists ledger_entries (
  id uuid primary key default gen_random_uuid(),
  payer text not null,
  amount numeric not null,
  description text,
  split jsonb not null default '[]'::jsonb,
  timestamp timestamptz not null default now(),
  receipt_url text
);

create table if not exists pending_items (
  id uuid primary key default gen_random_uuid(),
  description text not null,
  raised_by text not null,
  raised_at timestamptz not null default now(),
  deadline timestamptz,
  resolved boolean not null default false,
  resolved_at timestamptz,
  resolved_by text
);

create table if not exists maintenance_issues (
  id uuid primary key default gen_random_uuid(),
  description text not null,
  reported_by text not null,
  status text not null,
  priority text not null,
  first_seen_at timestamptz not null default now(),
  last_updated_at timestamptz not null default now(),
  resolution_notes text,
  landlord_notified_at timestamptz,
  scheduled_for timestamptz,
  vendor text,
  photo_urls jsonb not null default '[]'::jsonb
);

create table if not exists house_events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  event_date date not null,
  event_time text,
  duration_minutes integer,
  all_day boolean not null default false,
  created_by text not null,
  affects_members jsonb not null default '[]'::jsonb,
  event_type text not null,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists consumption_patterns (
  id uuid primary key default gen_random_uuid(),
  item_name text not null unique,
  avg_days_between_orders numeric,
  last_ordered_at timestamptz,
  times_ordered integer not null default 0,
  typical_requesters jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists order_jobs (
  id uuid primary key default gen_random_uuid(),
  chat_id text not null,
  status text not null,
  items jsonb not null default '[]'::jsonb,
  session_id text,
  cart jsonb,
  subtotal numeric,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists move_events (
  id uuid primary key default gen_random_uuid(),
  chat_id text not null,
  type text not null,
  member text not null,
  phase text not null,
  target_date date,
  deposit_amount numeric,
  deposit_deductions jsonb not null default '[]'::jsonb,
  shared_assets jsonb not null default '[]'::jsonb,
  utility_transfer_status jsonb not null default '{}'::jsonb,
  final_balance numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists utility_accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  login_url text,
  context_id text,
  account_holder text,
  autopay_enabled boolean not null default false,
  alert_threshold_pct numeric not null default 15,
  created_at timestamptz not null default now()
);

create table if not exists utility_bills (
  id uuid primary key default gen_random_uuid(),
  account_id text not null,
  amount numeric not null,
  due_date date,
  period_start date,
  period_end date,
  status text not null,
  fetched_at timestamptz not null default now()
);

create index if not exists grocery_items_fulfilled_idx on grocery_items (fulfilled);
create index if not exists ledger_entries_timestamp_idx on ledger_entries (timestamp);
create index if not exists pending_items_resolved_idx on pending_items (resolved);
create index if not exists maintenance_issues_status_idx on maintenance_issues (status);
create index if not exists house_events_event_date_idx on house_events (event_date);
create index if not exists order_jobs_chat_id_idx on order_jobs (chat_id);
create index if not exists utility_bills_account_id_idx on utility_bills (account_id);
`;

function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-api-key": INSFORGE_API_KEY,
  };
}

/** Treat 2xx and any "already exists" style conflict as success. */
function isAlreadyExists(status: number, body: string): boolean {
  if (status === 409) return true;
  const b = body.toLowerCase();
  return (status === 400 || status === 422) && (b.includes("already exists") || b.includes("duplicate"));
}

async function runRawSql(query: string): Promise<unknown> {
  const res = await fetch(`${INSFORGE_URL}${RAW_SQL_PATH}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ query, params: [] }),
  });
  const body = await res.text();
  if (res.ok) {
    return body ? JSON.parse(body) : null;
  }
  throw new Error(`raw sql → ${res.status}: ${body}`);
}

async function ensureBucket(name: string): Promise<void> {
  const res = await fetch(`${INSFORGE_URL}${BUCKETS_PATH}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ bucketName: name, isPublic: true }),
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

  log("provision.start", { url: INSFORGE_URL, tables: TABLE_NAMES.length, bucket: INSFORGE_BUCKET });

  await runRawSql(SCHEMA_SQL);
  for (const table of TABLE_NAMES) log("provision.table_ready", { table });
  await ensureBucket(INSFORGE_BUCKET);

  log("provision.done", { tables: TABLE_NAMES.length, bucket: INSFORGE_BUCKET });
  console.log(`✓ provisioned ${TABLE_NAMES.length} tables + bucket "${INSFORGE_BUCKET}" on InsForge`);
}

main().catch((err) => {
  log("provision.failed", { error: String(err) });
  console.error(err);
  process.exit(1);
});
