import type { Pool } from "pg";
import { getLedgerEntries } from "./db.js";
import { log } from "./log.js";
import { money, type LedgerEntry } from "./state.js";

export type SpendingGroupBy = "category" | "member" | "month";

export interface SpendingReportOptions {
  since?: string;
  groupBy?: SpendingGroupBy;
}

export interface SpendingBucket {
  key: string;
  total: number;
  count: number;
}

export interface MemberSpend {
  member: string;
  paid: number;
  share: number;
  net: number;
}

export interface SpendingReport {
  since: string;
  through: string;
  groupBy: SpendingGroupBy;
  total: number;
  transactionCount: number;
  byCategory: SpendingBucket[];
  byMember: MemberSpend[];
  byMonth: SpendingBucket[];
  monthOverMonth?: {
    currentMonth: string;
    previousMonth: string;
    currentTotal: number;
    previousTotal: number;
    changePct: number;
  };
  source: "hydra" | "ledger";
  summary: string;
}

let pool: Pool | null = null;

function defaultSince(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function normalizeSince(since?: string): string {
  if (!since) return defaultSince();
  const d = new Date(since);
  return Number.isNaN(d.getTime()) ? defaultSince() : d.toISOString();
}

function categoryFor(description: string): string {
  const d = description.toLowerCase();
  if (/(grocery|groceries|trader joe|costco|whole foods|safeway|oat milk|eggs|milk)/.test(d)) return "groceries";
  if (/(rent|landlord|lease)/.test(d)) return "rent";
  if (/(pg&e|pge|electric|gas|water|utility|utilities|comcast|xfinity|internet|wifi)/.test(d)) return "utilities";
  if (/(takeout|delivery|restaurant|dinner|lunch|pizza|coffee|doordash|uber eats)/.test(d)) return "food";
  if (/(clean|supplies|toilet paper|paper towel|soap|detergent|trash)/.test(d)) return "supplies";
  if (/(repair|maintenance|plumber|electrician|fix|broken|leak)/.test(d)) return "maintenance";
  return "other";
}

function monthKey(timestamp: string): string {
  return timestamp.slice(0, 7);
}

function parseSplit(split: unknown): string[] {
  if (Array.isArray(split)) return split.map(String).filter(Boolean);
  if (typeof split === "string") {
    try {
      const parsed = JSON.parse(split) as unknown;
      return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function addBucket(map: Map<string, SpendingBucket>, key: string, amount: number): void {
  const cur = map.get(key) ?? { key, total: 0, count: 0 };
  cur.total += amount;
  cur.count += 1;
  map.set(key, cur);
}

function sortedBuckets(map: Map<string, SpendingBucket>): SpendingBucket[] {
  return [...map.values()].sort((a, b) => b.total - a.total);
}

function computeFromEntries(
  entries: LedgerEntry[],
  opts: Required<Pick<SpendingReportOptions, "groupBy">> & { since: string },
  source: SpendingReport["source"]
): SpendingReport {
  const filtered = entries.filter((e) => Date.parse(e.timestamp) >= Date.parse(opts.since));
  const byCategory = new Map<string, SpendingBucket>();
  const byMonth = new Map<string, SpendingBucket>();
  const members = new Map<string, MemberSpend>();

  for (const entry of filtered) {
    const amount = Number(entry.amount) || 0;
    addBucket(byCategory, categoryFor(entry.description), amount);
    addBucket(byMonth, monthKey(entry.timestamp), amount);

    const payer = entry.payer;
    const payerRow = members.get(payer) ?? { member: payer, paid: 0, share: 0, net: 0 };
    payerRow.paid += amount;
    payerRow.net += amount;
    members.set(payer, payerRow);

    const split = parseSplit(entry.split);
    const share = split.length > 0 ? amount / split.length : 0;
    for (const member of split) {
      const row = members.get(member) ?? { member, paid: 0, share: 0, net: 0 };
      row.share += share;
      row.net -= share;
      members.set(member, row);
    }
  }

  const byCategoryRows = sortedBuckets(byCategory);
  const byMonthRows = [...byMonth.values()].sort((a, b) => a.key.localeCompare(b.key));
  const byMemberRows = [...members.values()].sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
  const total = filtered.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);

  const now = new Date();
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const previousMonth = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`;
  const currentTotal = byMonth.get(currentMonth)?.total ?? 0;
  const previousTotal = byMonth.get(previousMonth)?.total ?? 0;
  const changePct = previousTotal > 0 ? ((currentTotal - previousTotal) / previousTotal) * 100 : 0;

  return {
    since: opts.since,
    through: new Date().toISOString(),
    groupBy: opts.groupBy,
    total,
    transactionCount: filtered.length,
    byCategory: byCategoryRows,
    byMember: byMemberRows,
    byMonth: byMonthRows,
    monthOverMonth: { currentMonth, previousMonth, currentTotal, previousTotal, changePct },
    source,
    summary: formatSpendingSummary({
      total,
      transactionCount: filtered.length,
      groupBy: opts.groupBy,
      byCategory: byCategoryRows,
      byMember: byMemberRows,
      byMonth: byMonthRows,
      source,
    }),
  };
}

async function hydraPool(): Promise<Pool | null> {
  const connectionString = process.env.HYDRA_DATABASE_URL;
  if (!connectionString) return null;
  if (pool) return pool;

  const pg = await import("pg");
  pool = new pg.Pool({
    connectionString,
    ssl: connectionString.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined,
  });
  return pool;
}

const CATEGORY_SQL = `
case
  when description ~* '(grocery|groceries|trader joe|costco|whole foods|safeway|oat milk|eggs|milk)' then 'groceries'
  when description ~* '(rent|landlord|lease)' then 'rent'
  when description ~* '(pg&e|pge|electric|gas|water|utility|utilities|comcast|xfinity|internet|wifi)' then 'utilities'
  when description ~* '(takeout|delivery|restaurant|dinner|lunch|pizza|coffee|doordash|uber eats)' then 'food'
  when description ~* '(clean|supplies|toilet paper|paper towel|soap|detergent|trash)' then 'supplies'
  when description ~* '(repair|maintenance|plumber|electrician|fix|broken|leak)' then 'maintenance'
  else 'other'
end`;

async function spendingReportFromHydra(
  opts: Required<Pick<SpendingReportOptions, "groupBy">> & { since: string }
): Promise<SpendingReport | null> {
  const db = await hydraPool();
  if (!db) return null;

  const since = opts.since;
  const categorySql = `
    select ${CATEGORY_SQL} as key, sum(amount::numeric)::float8 as total, count(*)::int as count
    from ledger_entries
    where timestamp >= $1::timestamptz
    group by 1
    order by total desc`;
  const monthSql = `
    select to_char(date_trunc('month', timestamp), 'YYYY-MM') as key,
           sum(amount::numeric)::float8 as total,
           count(*)::int as count
    from ledger_entries
    where timestamp >= $1::timestamptz
    group by 1
    order by key asc`;
  const memberSql = `
    with entries as (
      select payer, amount::numeric as amount, split
      from ledger_entries
      where timestamp >= $1::timestamptz
    ),
    paid as (
      select payer as member, sum(amount)::float8 as paid, 0::float8 as share
      from entries
      group by payer
    ),
    consumed as (
      select member, 0::float8 as paid,
             sum(amount / nullif(jsonb_array_length(split), 0))::float8 as share
      from entries
      cross join lateral jsonb_array_elements_text(split) as member
      group by member
    )
    select member,
           sum(paid)::float8 as paid,
           sum(share)::float8 as share,
           (sum(paid) - sum(share))::float8 as net
    from (
      select * from paid
      union all
      select * from consumed
    ) rows
    group by member
    order by abs(sum(paid) - sum(share)) desc`;
  const totalSql = `
    select coalesce(sum(amount::numeric), 0)::float8 as total, count(*)::int as count
    from ledger_entries
    where timestamp >= $1::timestamptz`;

  try {
    const [categoryResult, monthResult, memberResult, totalResult] = await Promise.all([
      db.query<SpendingBucket>(categorySql, [since]),
      db.query<SpendingBucket>(monthSql, [since]),
      db.query<MemberSpend>(memberSql, [since]),
      db.query<{ total: number; count: number }>(totalSql, [since]),
    ]);

    const byCategory = categoryResult.rows.map((r) => ({
      key: r.key,
      total: Number(r.total) || 0,
      count: Number(r.count) || 0,
    }));
    const byMonth = monthResult.rows.map((r) => ({
      key: r.key,
      total: Number(r.total) || 0,
      count: Number(r.count) || 0,
    }));
    const byMember = memberResult.rows.map((r) => ({
      member: r.member,
      paid: Number(r.paid) || 0,
      share: Number(r.share) || 0,
      net: Number(r.net) || 0,
    }));
    const total = Number(totalResult.rows[0]?.total ?? 0);
    const transactionCount = Number(totalResult.rows[0]?.count ?? 0);

    const now = new Date();
    const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const previousMonth = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`;
    const currentTotal = byMonth.find((m) => m.key === currentMonth)?.total ?? 0;
    const previousTotal = byMonth.find((m) => m.key === previousMonth)?.total ?? 0;
    const changePct = previousTotal > 0 ? ((currentTotal - previousTotal) / previousTotal) * 100 : 0;

    return {
      since,
      through: new Date().toISOString(),
      groupBy: opts.groupBy,
      total,
      transactionCount,
      byCategory,
      byMember,
      byMonth,
      monthOverMonth: { currentMonth, previousMonth, currentTotal, previousTotal, changePct },
      source: "hydra",
      summary: formatSpendingSummary({
        total,
        transactionCount,
        groupBy: opts.groupBy,
        byCategory,
        byMember,
        byMonth,
        source: "hydra",
      }),
    };
  } catch (err) {
    log("analytics.hydra_failed", { error: String(err) });
    return null;
  }
}

function pct(n: number): string {
  const rounded = Math.round(n);
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

function formatSpendingSummary(args: {
  total: number;
  transactionCount: number;
  groupBy: SpendingGroupBy;
  byCategory: SpendingBucket[];
  byMember: MemberSpend[];
  byMonth: SpendingBucket[];
  source: SpendingReport["source"];
}): string {
  if (args.transactionCount === 0) return "no spending logged for that period.";

  if (args.groupBy === "member") {
    const lines = args.byMember
      .slice(0, 5)
      .map((m) => `${m.member.toLowerCase()}: paid ${money(m.paid)}, share ${money(m.share)}, net ${m.net >= 0 ? "owed" : "owes"} ${money(Math.abs(m.net))}`);
    return `spending: ${money(args.total)} across ${args.transactionCount} charges.\n${lines.join("\n")}`;
  }

  if (args.groupBy === "month") {
    const lines = args.byMonth.slice(-6).map((m) => `${m.key}: ${money(m.total)}`);
    return `spending by month:\n${lines.join("\n")}`;
  }

  const top = args.byCategory.slice(0, 5).map((c) => `${c.key}: ${money(c.total)}`);
  return `spending: ${money(args.total)} across ${args.transactionCount} charges.\n${top.join("\n")}`;
}

export async function spendingReport(opts: SpendingReportOptions = {}): Promise<SpendingReport> {
  const normalized = {
    since: normalizeSince(opts.since),
    groupBy: opts.groupBy ?? "category",
  };

  const hydra = await spendingReportFromHydra(normalized);
  if (hydra) {
    log("analytics.report", { source: "hydra", groupBy: normalized.groupBy, since: normalized.since });
    return hydra;
  }

  const entries = await getLedgerEntries();
  const report = computeFromEntries(entries, normalized, "ledger");
  log("analytics.report", { source: "ledger", groupBy: normalized.groupBy, since: normalized.since });
  return report;
}

export async function categorySpikeReport(now: Date = new Date()): Promise<{
  category: string;
  currentTotal: number;
  previousTotal: number;
  changePct: number;
} | null> {
  const currentStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const previousStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const previousEnd = currentStart;
  const hydraSpike = await categorySpikeFromHydra(previousStart, currentStart, now);
  if (hydraSpike) return hydraSpike;

  const entries = await getLedgerEntries();

  const current = new Map<string, number>();
  const previous = new Map<string, number>();

  for (const entry of entries) {
    const ts = new Date(entry.timestamp);
    const amount = Number(entry.amount) || 0;
    const category = categoryFor(entry.description);
    if (ts >= currentStart && ts <= now) {
      current.set(category, (current.get(category) ?? 0) + amount);
    } else if (ts >= previousStart && ts < previousEnd) {
      previous.set(category, (previous.get(category) ?? 0) + amount);
    }
  }

  let biggest: { category: string; currentTotal: number; previousTotal: number; changePct: number } | null = null;
  for (const [category, currentTotal] of current) {
    const previousTotal = previous.get(category) ?? 0;
    if (previousTotal < 25 || currentTotal < 50) continue;
    const changePct = ((currentTotal - previousTotal) / previousTotal) * 100;
    if (changePct < 35) continue;
    if (!biggest || changePct > biggest.changePct) {
      biggest = { category, currentTotal, previousTotal, changePct };
    }
  }

  return biggest;
}

async function categorySpikeFromHydra(
  previousStart: Date,
  currentStart: Date,
  now: Date
): Promise<{
  category: string;
  currentTotal: number;
  previousTotal: number;
  changePct: number;
} | null> {
  const db = await hydraPool();
  if (!db) return null;

  const sql = `
    select ${CATEGORY_SQL} as category,
           coalesce(sum(case when timestamp >= $2::timestamptz then amount::numeric else 0 end), 0)::float8 as "currentTotal",
           coalesce(sum(case when timestamp >= $1::timestamptz and timestamp < $2::timestamptz then amount::numeric else 0 end), 0)::float8 as "previousTotal"
    from ledger_entries
    where timestamp >= $1::timestamptz
      and timestamp <= $3::timestamptz
    group by 1`;

  try {
    const result = await db.query<{ category: string; currentTotal: number; previousTotal: number }>(sql, [
      previousStart.toISOString(),
      currentStart.toISOString(),
      now.toISOString(),
    ]);
    let biggest: { category: string; currentTotal: number; previousTotal: number; changePct: number } | null = null;
    for (const row of result.rows) {
      const currentTotal = Number(row.currentTotal) || 0;
      const previousTotal = Number(row.previousTotal) || 0;
      if (previousTotal < 25 || currentTotal < 50) continue;
      const changePct = ((currentTotal - previousTotal) / previousTotal) * 100;
      if (changePct < 35) continue;
      if (!biggest || changePct > biggest.changePct) {
        biggest = { category: row.category, currentTotal, previousTotal, changePct };
      }
    }
    if (biggest) log("analytics.spike", { source: "hydra", ...biggest });
    return biggest;
  } catch (err) {
    log("analytics.hydra_spike_failed", { error: String(err) });
    return null;
  }
}

export function formatSpike(spike: NonNullable<Awaited<ReturnType<typeof categorySpikeReport>>>): string {
  return `${spike.category} is up ${pct(spike.changePct)} vs last month (${money(spike.previousTotal)} -> ${money(spike.currentTotal)})`;
}
