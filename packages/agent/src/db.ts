import "./env.js";
import type {
  GroceryItem,
  LedgerEntry,
  PendingItem,
  MaintenanceIssue,
  HouseEvent,
  ConsumptionPattern,
  OrderJob,
  MoveEvent,
  UtilityAccount,
  UtilityBill,
} from "./state.js";
import { money } from "./state.js";
import { log } from "./log.js";

// ── Backend selection ───────────────────────────────────────────────────────
//
// Precedence: InsForge → Butterbase → in-memory. Whichever is configured first
// wins. All three speak the same PostgREST filter grammar (eq./gte./lte./order/
// limit), so only BASE + the auth token differ between the two REST backends —
// every domain function below is backend-agnostic.

// InsForge — agent-native backend (Postgres + storage). Its database REST API is
// PostgREST-compatible; DB records live under the records path, storage under the
// buckets path. If your InsForge deployment mounts these elsewhere, adjust the
// two path constants here (and the mirror in scripts/provision.ts).
export const INSFORGE_URL = (process.env.INSFORGE_URL ?? "").replace(/\/+$/, "");
export const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY ?? "";
export const INSFORGE_BUCKET = process.env.INSFORGE_STORAGE_BUCKET || "receipts";
export const INSFORGE_DB_PATH = "/api/database/records";
export const INSFORGE_STORAGE_PATH = "/api/storage/buckets";
export const USE_INSFORGE = !!INSFORGE_URL && !!INSFORGE_API_KEY;

// Butterbase — the original REST backend.
const APP_ID = process.env.BUTTERBASE_APP_ID ?? "";
const API_KEY = process.env.BUTTERBASE_API_KEY ?? "";

// When neither remote backend is configured, the whole state layer runs in an
// in-memory store so the app works fully offline — critical for demos. State
// resets on restart; the bridge re-seeds members on boot.
const USE_MEMORY = !USE_INSFORGE && (!APP_ID || !API_KEY);

// Resolved REST endpoint + bearer token for the active remote backend.
const BASE = USE_INSFORGE
  ? `${INSFORGE_URL}${INSFORGE_DB_PATH}`
  : `https://api.butterbase.ai/v1/${APP_ID}`;
const TOKEN = USE_INSFORGE ? INSFORGE_API_KEY : API_KEY;

if (USE_INSFORGE) {
  console.warn(
    `[${new Date().toISOString()}] [db.insforge_mode] using InsForge backend at ${INSFORGE_URL}`
  );
} else if (USE_MEMORY) {
  console.warn(
    `[${new Date().toISOString()}] [db.memory_mode] no backend configured — using in-memory state (resets on restart)`
  );
}

// ── In-memory backend (PostgREST-subset emulation) ─────────────────────────────

type Row = Record<string, unknown>;
const mem: Record<string, Row[]> = {};
const memTable = (t: string): Row[] => (mem[t] ??= []);

/** Match a row against a qs filter map (supports eq./gte./lte.; ignores `order`). */
function memMatch(row: Row, qs: Record<string, string>): boolean {
  for (const [k, raw] of Object.entries(qs)) {
    if (k === "order") continue;
    const dot = raw.indexOf(".");
    const op = raw.slice(0, dot);
    const val = raw.slice(dot + 1);
    const cur = String(row[k] ?? "");
    if (op === "eq" && cur !== val) return false;
    if (op === "gte" && !(cur >= val)) return false;
    if (op === "lte" && !(cur <= val)) return false;
  }
  return true;
}

function memGet<T>(table: string, qs?: Record<string, string>): T[] {
  let rows = memTable(table).map((r) => ({ ...r }));
  if (qs) {
    rows = rows.filter((r) => memMatch(r, qs));
    if (qs.order) {
      const i = qs.order.lastIndexOf(".");
      const col = qs.order.slice(0, i);
      const dir = qs.order.slice(i + 1);
      rows.sort((a, b) => String(a[col] ?? "").localeCompare(String(b[col] ?? "")));
      if (dir === "desc") rows.reverse();
    }
  }
  return rows as T[];
}

function memPost<T>(table: string, body: unknown): T {
  const row: Row = { ...(body as Row) };
  if (row.id == null) row.id = crypto.randomUUID();
  memTable(table).push(row);
  return { ...row } as T;
}

function memPatch<T>(table: string, id: string, body: unknown): T | null {
  const t = memTable(table);
  const idx = t.findIndex((r) => String(r.id) === String(id));
  if (idx === -1) return null;
  t[idx] = { ...t[idx], ...(body as Row) };
  return { ...t[idx] } as T;
}

function asNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function asRecord<T extends Record<string, unknown>>(value: unknown): T {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as T;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : ({} as T);
    } catch {
      return {} as T;
    }
  }
  return {} as T;
}

// ── Low-level HTTP helpers ─────────────────────────────────────────────────────

function hdrs() {
  return { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };
}

function authHdr() {
  return { Authorization: `Bearer ${TOKEN}` };
}

async function readJson<T>(r: Response): Promise<T | null> {
  if (r.status === 204) return null;
  const text = await r.text();
  return text ? (JSON.parse(text) as T) : null;
}

async function get<T>(table: string, qs?: Record<string, string>): Promise<T[]> {
  if (USE_MEMORY) return memGet<T>(table, qs);
  const url = new URL(`${BASE}/${table}`);
  if (qs) Object.entries(qs).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url.toString(), { headers: authHdr() });
  if (!r.ok) throw new Error(`GET ${table} ${r.status}: ${await r.text()}`);
  return r.json() as Promise<T[]>;
}

async function getOne<T>(table: string, id: string): Promise<T | null> {
  // Use query-filter form to avoid Butterbase's UUID-only path-param validation.
  const rows = await get<T>(table, { id: `eq.${id}` });
  return rows[0] ?? null;
}

async function post<T>(table: string, body: unknown): Promise<T> {
  if (USE_MEMORY) return memPost<T>(table, body);
  if (USE_INSFORGE) {
    const url = new URL(`${BASE}/${table}`);
    url.searchParams.set("select", "*");
    const r = await fetch(url.toString(), {
      method: "POST",
      headers: { ...hdrs(), Prefer: "return=representation" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`POST ${table} ${r.status}: ${await r.text()}`);
    const data = await readJson<T[]>(r);
    return (data?.[0] ?? (body as T));
  }
  const r = await fetch(`${BASE}/${table}`, {
    method: "POST",
    headers: hdrs(),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${table} ${r.status}: ${await r.text()}`);
  return r.json() as Promise<T>;
}

async function patch<T>(table: string, id: string, body: unknown): Promise<T> {
  if (USE_MEMORY) {
    // Patch-if-exists, create-if-missing — callers always fetch the id first.
    return (memPatch<T>(table, id, body) ?? memPost<T>(table, { id, ...(body as Row) }));
  }
  if (USE_INSFORGE) {
    const url = new URL(`${BASE}/${table}`);
    url.searchParams.set("id", `eq.${id}`);
    url.searchParams.set("select", "*");
    const r = await fetch(url.toString(), {
      method: "PATCH",
      headers: { ...hdrs(), Prefer: "return=representation" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`PATCH ${table}/${id} ${r.status}: ${await r.text()}`);
    const data = await readJson<T[]>(r);
    if (!data?.[0]) throw new Error(`PATCH ${table}/${id}: row not found`);
    return data[0];
  }
  const r = await fetch(`${BASE}/${table}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: hdrs(),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`PATCH ${table}/${id} ${r.status}: ${await r.text()}`);
  return r.json() as Promise<T>;
}

async function del(table: string, id: string): Promise<void> {
  if (USE_MEMORY) {
    const t = memTable(table);
    const idx = t.findIndex((r) => String(r.id) === String(id));
    if (idx !== -1) t.splice(idx, 1);
    return;
  }
  if (USE_INSFORGE) {
    const url = new URL(`${BASE}/${table}`);
    url.searchParams.set("id", `eq.${id}`);
    const r = await fetch(url.toString(), {
      method: "DELETE",
      headers: authHdr(),
    });
    if (!r.ok && r.status !== 404) throw new Error(`DELETE ${table}/${id} ${r.status}: ${await r.text()}`);
    return;
  }
  const r = await fetch(`${BASE}/${table}/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHdr(),
  });
  if (!r.ok && r.status !== 404) throw new Error(`DELETE ${table}/${id} ${r.status}: ${await r.text()}`);
}

/** PATCH if exists, POST if not. */
async function upsert<T>(table: string, id: string, body: unknown): Promise<T> {
  if (USE_MEMORY) {
    return (memPatch<T>(table, id, body) ?? memPost<T>(table, { id, ...(body as Row) }));
  }
  if (USE_INSFORGE) {
    const existing = await getOne<T>(table, id);
    if (existing) return patch<T>(table, id, body);
    return post<T>(table, { id, ...(body as Row) });
  }
  const r = await fetch(`${BASE}/${table}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: hdrs(),
    body: JSON.stringify(body),
  });
  if (r.ok) return r.json() as Promise<T>;
  if (r.status === 404) return post<T>(table, body);
  throw new Error(`UPSERT ${table}/${id} ${r.status}: ${await r.text()}`);
}

// ── Storage (InsForge object storage) ──────────────────────────────────────────

/** Decode a data: URL or bare base64 string into raw bytes + mime type. */
function decodeBase64Image(imageBase64: string): { bytes: Buffer; mime: string } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(imageBase64);
  if (m) return { bytes: Buffer.from(m[2], "base64"), mime: m[1] };
  return { bytes: Buffer.from(imageBase64, "base64"), mime: "image/jpeg" };
}

/**
 * Upload a receipt image to the InsForge storage bucket and return a URL that
 * can be persisted alongside the ledger entry. Only active when InsForge is
 * configured; returns null otherwise or on any failure (storage must never break
 * the receipt-parsing path). The demo runs fine without it.
 */
export async function uploadReceiptImage(
  imageBase64: string,
  filename?: string
): Promise<string | null> {
  if (!USE_INSFORGE) return null;
  try {
    const { bytes, mime } = decodeBase64Image(imageBase64);
    const ext = mime.split("/")[1]?.replace("jpeg", "jpg") ?? "jpg";
    const name = filename ?? `receipt-${crypto.randomUUID()}.${ext}`;
    const key = `receipts/${name}`;
    const url = `${INSFORGE_URL}${INSFORGE_STORAGE_PATH}/${encodeURIComponent(INSFORGE_BUCKET)}/objects/${encodeURIComponent(key)}`;

    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(bytes)], { type: mime }), name);

    const r = await fetch(url, {
      method: "PUT",
      headers: authHdr(), // multipart boundary set automatically by fetch
      body: form,
    });
    if (!r.ok) throw new Error(`upload ${r.status}: ${await r.text()}`);

    // Prefer an explicit URL from the response; fall back to the canonical
    // object path (works for public buckets).
    const data = (await r.json().catch(() => ({}))) as {
      url?: string; publicUrl?: string; public_url?: string; key?: string; name?: string;
    };
    const resolved =
      data.url ??
      data.publicUrl ??
      data.public_url ??
      `${INSFORGE_URL}${INSFORGE_STORAGE_PATH}/${encodeURIComponent(INSFORGE_BUCKET)}/objects/${encodeURIComponent(
        data.key ?? data.name ?? key
      )}`;

    log("storage.receipt_uploaded", { key: data.key ?? key, url: resolved });
    return resolved;
  } catch (err) {
    log("storage.receipt_upload_failed", { error: String(err) });
    return null;
  }
}

// ── Members + balances ─────────────────────────────────────────────────────────

export async function getMembers(): Promise<string[]> {
  const rows = await get<{ name: string }>("members");
  return rows.map((r) => r.name);
}

export async function getAllBalances(): Promise<Record<string, number>> {
  const rows = await get<{ name: string; balance: unknown }>("members");
  return Object.fromEntries(rows.map((r) => [r.name, asNumber(r.balance)]));
}

export async function getMemberBalance(name: string): Promise<number> {
  const rows = await get<{ balance: unknown }>("members", { name: `eq.${name}` });
  return asNumber(rows[0]?.balance);
}

/** Add members that don't exist yet; existing balances are untouched. */
export async function setMembers(names: string[]): Promise<void> {
  const existing = await get<{ name: string }>("members");
  const existingNames = new Set(existing.map((r) => r.name));
  await Promise.all(
    names.filter((n) => !existingNames.has(n)).map((n) => post("members", { name: n, balance: 0 }))
  );
}

export async function setBalance(name: string, balance: number): Promise<void> {
  const rows = await get<{ id: string }>("members", { name: `eq.${name}` });
  if (rows[0]?.id) {
    await patch("members", rows[0].id, { balance });
  } else {
    await post("members", { name, balance });
  }
}

export async function adjustBalance(name: string, delta: number): Promise<void> {
  const rows = await get<{ id: string; balance: unknown }>("members", { name: `eq.${name}` });
  if (rows[0]?.id) {
    await patch("members", rows[0].id, { balance: asNumber(rows[0].balance) + delta });
  } else {
    await post("members", { name, balance: delta });
  }
}

// ── Household facts ────────────────────────────────────────────────────────────

export async function getAllFacts(): Promise<Record<string, string>> {
  const rows = await get<{ key: string; value: string }>("household_facts");
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function getFact(key: string): Promise<string | undefined> {
  const rows = await get<{ value: string }>("household_facts", { key: `eq.${key}` });
  return rows[0]?.value;
}

export async function setFact(key: string, value: string): Promise<void> {
  const rows = await get<{ id: string }>("household_facts", { key: `eq.${key}` });
  if (rows[0]?.id) {
    await patch("household_facts", rows[0].id, { value });
  } else {
    await post("household_facts", { key, value });
  }
}

export async function deleteFact(key: string): Promise<void> {
  const rows = await get<{ id: string }>("household_facts", { key: `eq.${key}` });
  if (rows[0]?.id) await del("household_facts", rows[0].id);
}

// ── Household config (scalar key-value for lastGroceryRun etc.) ───────────────

export async function getConfig(key: string): Promise<string | undefined> {
  const rows = await get<{ value: string }>("household_config", { key: `eq.${key}` });
  return rows[0]?.value;
}

export async function setConfig(key: string, value: string): Promise<void> {
  const rows = await get<{ id: string }>("household_config", { key: `eq.${key}` });
  if (rows[0]?.id) {
    await patch("household_config", rows[0].id, { value });
  } else {
    await post("household_config", { key, value });
  }
}

// ── Grocery items ──────────────────────────────────────────────────────────────

function toGroceryItem(r: {
  id: string; item: string; requested_by: string; added_at: string; fulfilled: boolean;
}): GroceryItem & { id: string } {
  return { id: r.id, item: r.item, requestedBy: r.requested_by, addedAt: r.added_at, fulfilled: r.fulfilled };
}

export async function getGroceryItems(openOnly = false): Promise<(GroceryItem & { id: string })[]> {
  const qs: Record<string, string> = openOnly ? { fulfilled: "eq.false" } : {};
  const rows = await get<{ id: string; item: string; requested_by: string; added_at: string; fulfilled: boolean }>(
    "grocery_items",
    qs
  );
  return rows.map(toGroceryItem);
}

export async function addGroceryItem(id: string, item: string, requestedBy: string): Promise<void> {
  await post("grocery_items", { id, item, requested_by: requestedBy });
}

export async function fulfillGroceryItem(id: string): Promise<void> {
  await patch("grocery_items", id, { fulfilled: true });
}

export async function removeGroceryItem(id: string): Promise<void> {
  await del("grocery_items", id);
}

export async function deleteAllFulfilledGrocery(): Promise<void> {
  const fulfilled = await get<{ id: string }>("grocery_items", { fulfilled: "eq.true" });
  await Promise.all(fulfilled.map((r) => del("grocery_items", r.id)));
}

// ── Ledger entries ─────────────────────────────────────────────────────────────

function toLedgerEntry(r: {
  id: string; payer: string; amount: unknown; description: string; split: unknown; timestamp: string;
  receipt_url?: string | null;
}): LedgerEntry {
  return {
    payer: r.payer,
    amount: asNumber(r.amount),
    description: r.description,
    split: asArray<string>(r.split),
    timestamp: r.timestamp,
    receiptUrl: r.receipt_url ?? undefined,
  };
}

export async function getLedgerEntries(limit?: number): Promise<LedgerEntry[]> {
  const qs: Record<string, string> = { order: "timestamp.asc" };
  if (limit) qs.limit = String(limit);
  const rows = await get<{ id: string; payer: string; amount: unknown; description: string; split: unknown; timestamp: string; receipt_url?: string | null }>(
    "ledger_entries",
    qs
  );
  return rows.map(toLedgerEntry);
}

export async function addLedgerEntry(id: string, entry: LedgerEntry): Promise<void> {
  await post("ledger_entries", {
    id,
    payer: entry.payer,
    amount: entry.amount,
    description: entry.description,
    split: JSON.stringify(entry.split),
    timestamp: entry.timestamp,
    receipt_url: entry.receiptUrl ?? null,
  });
}

// ── Pending items ──────────────────────────────────────────────────────────────

function toPendingItem(r: {
  id: string; description: string; raised_by: string; raised_at: string;
  deadline: string | null; resolved: boolean; resolved_at: string | null; resolved_by: string | null;
}): PendingItem {
  return {
    id: r.id,
    description: r.description,
    raisedBy: r.raised_by,
    raisedAt: r.raised_at,
    deadline: r.deadline ?? undefined,
    resolved: r.resolved,
    resolvedAt: r.resolved_at ?? undefined,
    resolvedBy: r.resolved_by ?? undefined,
  };
}

export async function getPendingItems(openOnly = false): Promise<PendingItem[]> {
  const qs: Record<string, string> = openOnly ? { resolved: "eq.false" } : {};
  const rows = await get<{
    id: string; description: string; raised_by: string; raised_at: string;
    deadline: string | null; resolved: boolean; resolved_at: string | null; resolved_by: string | null;
  }>("pending_items", qs);
  return rows.map(toPendingItem);
}

export async function addPendingItem(item: PendingItem): Promise<void> {
  await post("pending_items", {
    id: item.id,
    description: item.description,
    raised_by: item.raisedBy,
    raised_at: item.raisedAt,
    deadline: item.deadline ?? null,
    resolved: false,
  });
}

export async function resolvePendingItem(id: string, resolvedBy: string, resolvedAt: string): Promise<void> {
  await patch("pending_items", id, { resolved: true, resolved_by: resolvedBy, resolved_at: resolvedAt });
}

// ── Maintenance issues ─────────────────────────────────────────────────────────

function toMaintenanceIssue(r: {
  id: string; description: string; reported_by: string; status: string; priority: string;
  first_seen_at: string; last_updated_at: string; resolution_notes: string | null;
  landlord_notified_at: string | null; scheduled_for: string | null; vendor: string | null;
  photo_urls: string[];
}): MaintenanceIssue {
  return {
    id: r.id,
    description: r.description,
    reportedBy: r.reported_by,
    status: r.status as MaintenanceIssue["status"],
    priority: r.priority as MaintenanceIssue["priority"],
    firstSeenAt: r.first_seen_at,
    lastUpdatedAt: r.last_updated_at,
    resolutionNotes: r.resolution_notes ?? undefined,
    landlordNotifiedAt: r.landlord_notified_at ?? undefined,
    scheduledFor: r.scheduled_for ?? undefined,
    vendor: r.vendor ?? undefined,
    photoUrls: asArray<string>(r.photo_urls),
  };
}

export async function getMaintenanceIssues(statusFilter?: string): Promise<MaintenanceIssue[]> {
  const qs: Record<string, string> = {};
  if (statusFilter) qs.status = `eq.${statusFilter}`;
  const rows = await get<Parameters<typeof toMaintenanceIssue>[0]>("maintenance_issues", qs);
  return rows.map(toMaintenanceIssue);
}

export async function getMaintenanceIssue(id: string): Promise<MaintenanceIssue | undefined> {
  const row = await getOne<Parameters<typeof toMaintenanceIssue>[0]>("maintenance_issues", id);
  return row ? toMaintenanceIssue(row) : undefined;
}

export async function addMaintenanceIssue(issue: MaintenanceIssue): Promise<void> {
  await post("maintenance_issues", {
    id: issue.id,
    description: issue.description,
    reported_by: issue.reportedBy,
    status: issue.status,
    priority: issue.priority,
    first_seen_at: issue.firstSeenAt,
    last_updated_at: issue.lastUpdatedAt,
    photo_urls: JSON.stringify(issue.photoUrls),
  });
}

export async function patchMaintenanceIssue(
  id: string,
  patch_: Partial<{
    status: string; priority: string; lastUpdatedAt: string; resolutionNotes: string;
    landlordNotifiedAt: string; scheduledFor: string; vendor: string; photoUrls: string[];
  }>
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (patch_.status !== undefined) body.status = patch_.status;
  if (patch_.priority !== undefined) body.priority = patch_.priority;
  if (patch_.lastUpdatedAt !== undefined) body.last_updated_at = patch_.lastUpdatedAt;
  if (patch_.resolutionNotes !== undefined) body.resolution_notes = patch_.resolutionNotes;
  if (patch_.landlordNotifiedAt !== undefined) body.landlord_notified_at = patch_.landlordNotifiedAt;
  if (patch_.scheduledFor !== undefined) body.scheduled_for = patch_.scheduledFor;
  if (patch_.vendor !== undefined) body.vendor = patch_.vendor;
  if (patch_.photoUrls !== undefined) body.photo_urls = JSON.stringify(patch_.photoUrls);
  await patch("maintenance_issues", id, body);
}

// ── House events ───────────────────────────────────────────────────────────────

function toHouseEvent(r: {
  id: string; title: string; event_date: string; event_time: string | null;
  duration_minutes: number | null; all_day: boolean; created_by: string;
  affects_members: string[]; event_type: string; notes: string | null; created_at: string;
}): HouseEvent {
  return {
    id: r.id,
    title: r.title,
    eventDate: r.event_date,
    eventTime: r.event_time ?? undefined,
    durationMinutes: r.duration_minutes ?? undefined,
    allDay: r.all_day,
    createdBy: r.created_by,
    affectsMembers: asArray<string>(r.affects_members),
    eventType: r.event_type as HouseEvent["eventType"],
    notes: r.notes ?? undefined,
    createdAt: r.created_at,
  };
}

export async function getHouseEvents(fromDate?: string, toDate?: string): Promise<HouseEvent[]> {
  const qs: Record<string, string> = { order: "event_date.asc" };
  if (fromDate) qs.event_date = `gte.${fromDate}`;
  if (toDate) qs["event_date_end"] = `lte.${toDate}`; // used below via custom logic
  const rows = await get<Parameters<typeof toHouseEvent>[0]>("house_events", fromDate ? { event_date: `gte.${fromDate}`, order: "event_date.asc" } : { order: "event_date.asc" });
  return rows.map(toHouseEvent);
}

export async function addHouseEvent(event: HouseEvent): Promise<void> {
  await post("house_events", {
    id: event.id,
    title: event.title,
    event_date: event.eventDate,
    event_time: event.eventTime ?? null,
    duration_minutes: event.durationMinutes ?? null,
    all_day: event.allDay,
    created_by: event.createdBy,
    affects_members: JSON.stringify(event.affectsMembers),
    event_type: event.eventType,
    notes: event.notes ?? null,
  });
}

// ── Consumption patterns ───────────────────────────────────────────────────────

function toConsumptionPattern(r: {
  id: string; item_name: string; avg_days_between_orders: unknown;
  last_ordered_at: string; times_ordered: unknown; typical_requesters: unknown; updated_at: string;
}): ConsumptionPattern {
  return {
    id: r.id,
    itemName: r.item_name,
    avgDaysBetweenOrders: r.avg_days_between_orders == null ? undefined : asNumber(r.avg_days_between_orders),
    lastOrderedAt: r.last_ordered_at,
    timesOrdered: asNumber(r.times_ordered),
    typicalRequesters: asArray<string>(r.typical_requesters),
    updatedAt: r.updated_at,
  };
}

export async function getConsumptionPattern(itemName: string): Promise<ConsumptionPattern | undefined> {
  const rows = await get<Parameters<typeof toConsumptionPattern>[0]>("consumption_patterns", {
    item_name: `eq.${itemName}`,
  });
  return rows[0] ? toConsumptionPattern(rows[0]) : undefined;
}

export async function getAllConsumptionPatterns(): Promise<ConsumptionPattern[]> {
  const rows = await get<Parameters<typeof toConsumptionPattern>[0]>("consumption_patterns");
  return rows.map(toConsumptionPattern);
}

export async function upsertConsumptionPattern(pattern: ConsumptionPattern): Promise<void> {
  // item_name is the unique key; id is the PK
  const existing = await getConsumptionPattern(pattern.itemName);
  if (existing) {
    await patch("consumption_patterns", existing.id, {
      avg_days_between_orders: pattern.avgDaysBetweenOrders ?? null,
      last_ordered_at: pattern.lastOrderedAt,
      times_ordered: pattern.timesOrdered,
      typical_requesters: JSON.stringify(pattern.typicalRequesters),
      updated_at: pattern.updatedAt,
    });
  } else {
    await post("consumption_patterns", {
      id: pattern.id,
      item_name: pattern.itemName,
      avg_days_between_orders: pattern.avgDaysBetweenOrders ?? null,
      last_ordered_at: pattern.lastOrderedAt,
      times_ordered: pattern.timesOrdered,
      typical_requesters: JSON.stringify(pattern.typicalRequesters),
      updated_at: pattern.updatedAt,
    });
  }
}

// ── Order jobs ─────────────────────────────────────────────────────────────────

function toOrderJob(r: {
  id: string; chat_id: string; status: string;
  items: unknown;
  session_id: string | null; cart: unknown; subtotal: unknown;
  note: string | null; created_at: string; updated_at: string;
}): OrderJob {
  return {
    id: r.id,
    chatId: r.chat_id,
    status: r.status as OrderJob["status"],
    items: asArray<{ name: string; requestedBy: string }>(r.items),
    sessionId: r.session_id ?? undefined,
    cart: r.cart == null ? undefined : asArray<NonNullable<OrderJob["cart"]>[number]>(r.cart),
    subtotal: r.subtotal == null ? undefined : asNumber(r.subtotal),
    note: r.note ?? undefined,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function getOrderJobById(id: string): Promise<OrderJob | undefined> {
  const row = await getOne<Parameters<typeof toOrderJob>[0]>("order_jobs", id);
  return row ? toOrderJob(row) : undefined;
}

export async function getActiveJobForChatDb(chatId: string): Promise<OrderJob | undefined> {
  const terminal = ["done", "failed", "cancelled"];
  const rows = await get<Parameters<typeof toOrderJob>[0]>("order_jobs", { chat_id: `eq.${chatId}` });
  return rows.map(toOrderJob).find((j) => !terminal.includes(j.status));
}

export async function addOrderJob(job: OrderJob): Promise<void> {
  await post("order_jobs", {
    id: job.id,
    chat_id: job.chatId,
    status: job.status,
    items: JSON.stringify(job.items),
    session_id: job.sessionId ?? null,
    cart: job.cart != null ? JSON.stringify(job.cart) : null,
    subtotal: job.subtotal ?? null,
    note: job.note ?? null,
  });
}

export async function patchOrderJob(id: string, p: Partial<OrderJob>): Promise<void> {
  const body: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (p.status !== undefined) body.status = p.status;
  if (p.sessionId !== undefined) body.session_id = p.sessionId;
  if (p.cart !== undefined) body.cart = JSON.stringify(p.cart);
  if (p.subtotal !== undefined) body.subtotal = p.subtotal;
  if (p.note !== undefined) body.note = p.note;
  await patch("order_jobs", id, body);
}

// ── Move events ────────────────────────────────────────────────────────────────

function toMoveEvent(r: {
  id: string; chat_id: string; type: string; member: string; phase: string;
  target_date: string; deposit_amount: unknown;
  deposit_deductions: unknown;
  shared_assets: unknown;
  utility_transfer_status: unknown;
  final_balance: unknown; created_at: string; updated_at: string;
}): MoveEvent {
  return {
    id: r.id,
    chatId: r.chat_id,
    type: r.type as MoveEvent["type"],
    member: r.member,
    phase: r.phase as MoveEvent["phase"],
    targetDate: r.target_date,
    depositAmount: r.deposit_amount == null ? undefined : asNumber(r.deposit_amount),
    depositDeductions: asArray<MoveEvent["depositDeductions"][number]>(r.deposit_deductions),
    sharedAssets: asArray<MoveEvent["sharedAssets"][number]>(r.shared_assets),
    utilityTransferStatus: asRecord<MoveEvent["utilityTransferStatus"]>(r.utility_transfer_status),
    finalBalance: r.final_balance == null ? undefined : asNumber(r.final_balance),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function getMoveEvent(id: string): Promise<MoveEvent | undefined> {
  const row = await getOne<Parameters<typeof toMoveEvent>[0]>("move_events", id);
  return row ? toMoveEvent(row) : undefined;
}

export async function getAllMoveEvents(): Promise<MoveEvent[]> {
  const rows = await get<Parameters<typeof toMoveEvent>[0]>("move_events");
  return rows.map(toMoveEvent);
}

export async function addMoveEvent(event: MoveEvent): Promise<void> {
  await post("move_events", {
    id: event.id,
    chat_id: event.chatId,
    type: event.type,
    member: event.member,
    phase: event.phase,
    target_date: event.targetDate,
    deposit_amount: event.depositAmount ?? null,
    deposit_deductions: JSON.stringify(event.depositDeductions),
    shared_assets: JSON.stringify(event.sharedAssets),
    utility_transfer_status: JSON.stringify(event.utilityTransferStatus),
    final_balance: event.finalBalance ?? null,
  });
}

export async function patchMoveEvent(id: string, p: Partial<MoveEvent>): Promise<void> {
  const body: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (p.phase !== undefined) body.phase = p.phase;
  if (p.depositAmount !== undefined) body.deposit_amount = p.depositAmount;
  if (p.depositDeductions !== undefined) body.deposit_deductions = JSON.stringify(p.depositDeductions);
  if (p.sharedAssets !== undefined) body.shared_assets = JSON.stringify(p.sharedAssets);
  if (p.utilityTransferStatus !== undefined) body.utility_transfer_status = JSON.stringify(p.utilityTransferStatus);
  if (p.finalBalance !== undefined) body.final_balance = p.finalBalance;
  await patch("move_events", id, body);
}

// ── Utility accounts ───────────────────────────────────────────────────────────

function toUtilityAccount(r: {
  id: string; name: string; login_url: string; context_id: string;
  account_holder: string; autopay_enabled: boolean; alert_threshold_pct: unknown; created_at: string;
}): UtilityAccount {
  return {
    id: r.id,
    name: r.name,
    loginUrl: r.login_url,
    contextId: r.context_id,
    accountHolder: r.account_holder,
    autopayEnabled: r.autopay_enabled,
    alertThresholdPct: asNumber(r.alert_threshold_pct, 15),
    createdAt: r.created_at,
  };
}

export async function getUtilityAccount(id: string): Promise<UtilityAccount | undefined> {
  const row = await getOne<Parameters<typeof toUtilityAccount>[0]>("utility_accounts", id);
  return row ? toUtilityAccount(row) : undefined;
}

export async function getAllUtilityAccounts(): Promise<UtilityAccount[]> {
  const rows = await get<Parameters<typeof toUtilityAccount>[0]>("utility_accounts");
  return rows.map(toUtilityAccount);
}

export async function addUtilityAccount(account: UtilityAccount): Promise<void> {
  await post("utility_accounts", {
    id: account.id,
    name: account.name,
    login_url: account.loginUrl,
    context_id: account.contextId,
    account_holder: account.accountHolder,
    autopay_enabled: account.autopayEnabled,
    alert_threshold_pct: account.alertThresholdPct,
  });
}

// ── Utility bills ──────────────────────────────────────────────────────────────

function toUtilityBill(r: {
  id: string; account_id: string; amount: unknown; due_date: string | null;
  period_start: string | null; period_end: string | null; status: string; fetched_at: string;
}): UtilityBill {
  return {
    id: r.id,
    accountId: r.account_id,
    amount: asNumber(r.amount),
    dueDate: r.due_date ?? undefined,
    periodStart: r.period_start ?? undefined,
    periodEnd: r.period_end ?? undefined,
    status: r.status as UtilityBill["status"],
    fetchedAt: r.fetched_at,
  };
}

export async function getUtilityBill(id: string): Promise<UtilityBill | undefined> {
  const row = await getOne<Parameters<typeof toUtilityBill>[0]>("utility_bills", id);
  return row ? toUtilityBill(row) : undefined;
}

export async function getBillsForAccount(accountId: string): Promise<UtilityBill[]> {
  const rows = await get<Parameters<typeof toUtilityBill>[0]>("utility_bills", {
    account_id: `eq.${accountId}`,
    order: "fetched_at.desc",
  });
  return rows.map(toUtilityBill);
}

export async function addUtilityBill(bill: UtilityBill): Promise<void> {
  await post("utility_bills", {
    id: bill.id,
    account_id: bill.accountId,
    amount: bill.amount,
    due_date: bill.dueDate ?? null,
    period_start: bill.periodStart ?? null,
    period_end: bill.periodEnd ?? null,
    status: bill.status,
    fetched_at: bill.fetchedAt,
  });
}

export async function patchUtilityBill(id: string, p: Partial<UtilityBill>): Promise<void> {
  const body: Record<string, unknown> = {};
  if (p.status !== undefined) body.status = p.status;
  if (p.amount !== undefined) body.amount = p.amount;
  await patch("utility_bills", id, body);
}

// ── State serialization (replaces serializeState() in state.ts) ────────────────

function describeBalance(member: string, balance: number): string {
  if (balance > 0.005) return `${member} is owed ${money(balance)}`;
  if (balance < -0.005) return `${member} owes ${money(Math.abs(balance))}`;
  return `${member} is settled up`;
}

function daysAgo(iso: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000);
}

export async function buildSerializedState(now: Date = new Date()): Promise<string> {
  const [members, balances, groceries, facts, pending, openMaint, lastRun] = await Promise.all([
    getMembers(),
    getAllBalances(),
    getGroceryItems(true),
    getAllFacts(),
    getPendingItems(true),
    getMaintenanceIssues("open"),
    getConfig("last_grocery_run"),
  ]);

  const lines: string[] = ["CURRENT HOUSEHOLD STATE:"];

  lines.push(`Members: ${members.length ? members.join(", ") : "(none configured yet)"}`);

  const balanceLines = members.map((m) => describeBalance(m, balances[m] ?? 0));
  lines.push(`Balances: ${balanceLines.length ? balanceLines.join(", ") : "(none)"}`);

  lines.push(
    `Grocery list: ${
      groceries.length
        ? groceries.map((g) => `${g.item} (${g.requestedBy})`).join(", ")
        : "(empty)"
    }`
  );

  if (lastRun) {
    lines.push(`Last grocery run: ${lastRun.slice(0, 10)} (${daysAgo(lastRun, now)} days ago)`);
  }

  if (pending.length) {
    lines.push(
      `Open action items: ${pending
        .map((i) => {
          const age = Math.floor((now.getTime() - Date.parse(i.raisedAt)) / 3_600_000);
          const dl = i.deadline ? `, due ${new Date(i.deadline).toISOString().slice(11, 16)}` : "";
          return `"${i.description}" (${i.raisedBy}, ${age}h ago${dl})`;
        })
        .join("; ")}`
    );
  }

  if (openMaint.length) {
    lines.push(
      `Open maintenance: ${openMaint
        .map((i) => `${i.description} [${i.priority}] (${i.status})`)
        .join("; ")}`
    );
  }

  const factEntries = Object.entries(facts);
  if (factEntries.length) {
    lines.push(`Household facts: ${factEntries.map(([k, v]) => `${k}: ${v}`).join("; ")}`);
  }

  lines.push(`Today: ${now.toISOString().slice(0, 10)}`);
  return lines.join("\n");
}
