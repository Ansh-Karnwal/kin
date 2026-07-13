// ── Existing household state ──────────────────────────────────────────────────

export interface GroceryItem {
  item: string;
  requestedBy: string;
  addedAt: string;
  fulfilled: boolean;
}

export interface LedgerEntry {
  payer: string;
  amount: number;
  description: string;
  split: string[];
  timestamp: string;
}

export interface Chore {
  task: string;
  assignee: string;
  dueDate?: string;
  done: boolean;
}

export interface PendingItem {
  id: string;
  description: string;
  raisedBy: string;
  raisedAt: string;
  deadline?: string;
  resolved: boolean;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface HouseholdState {
  members: string[];
  balances: Record<string, number>; // positive = is owed money
  groceryList: GroceryItem[];
  ledger: LedgerEntry[];
  chores: Chore[];
  pendingItems: PendingItem[];
  householdFacts: Record<string, string>;
  lastGroceryRun?: string;
}

export const state: HouseholdState = {
  members: [],
  balances: {},
  groceryList: [],
  ledger: [],
  chores: [],
  pendingItems: [],
  householdFacts: {},
};

// ── Maintenance issues (Feature 1) ────────────────────────────────────────────

export type MaintenanceStatus = "open" | "landlord_notified" | "scheduled" | "resolved";
export type MaintenancePriority = "low" | "medium" | "urgent";

export interface MaintenanceIssue {
  id: string;
  description: string;
  reportedBy: string;
  status: MaintenanceStatus;
  priority: MaintenancePriority;
  firstSeenAt: string;
  lastUpdatedAt: string;
  resolutionNotes?: string;
  landlordNotifiedAt?: string;
  scheduledFor?: string;
  vendor?: string;
  photoUrls: string[];
}

/** In-memory store: issue id → issue */
export const maintenanceIssues = new Map<string, MaintenanceIssue>();

// ── House calendar (Feature 2) ────────────────────────────────────────────────

export type HouseEventType =
  | "repair"
  | "guest"
  | "travel"
  | "bill"
  | "social"
  | "move"
  | "package"
  | "other";

export interface HouseEvent {
  id: string;
  title: string;
  eventDate: string; // YYYY-MM-DD
  eventTime?: string; // HH:MM 24h
  durationMinutes?: number;
  allDay: boolean;
  createdBy: string;
  affectsMembers: string[]; // empty = whole house
  eventType: HouseEventType;
  notes?: string;
  createdAt: string;
}

export const houseEvents = new Map<string, HouseEvent>();

// ── Consumption patterns (Feature 3) ─────────────────────────────────────────

export interface ConsumptionPattern {
  id: string;
  itemName: string;
  /** Undefined until at least 2 orders — need two data points for an average. */
  avgDaysBetweenOrders?: number;
  lastOrderedAt: string;
  timesOrdered: number;
  typicalRequesters: string[];
  updatedAt: string;
}

/** Keyed by lowercase item name for fast lookup. */
export const consumptionPatterns = new Map<string, ConsumptionPattern>();

// ── Order jobs (Phase 8 / grocery ordering) ───────────────────────────────────

export type OrderStatus =
  | "building"
  | "awaiting_approval"
  | "awaiting_otp"
  | "placing"
  | "done"
  | "failed"
  | "cancelled";

export interface OrderCartItem {
  name: string;
  quantity: number;
  price: number;
}

export interface OrderJob {
  id: string;
  chatId: string;
  status: OrderStatus;
  items: Array<{ name: string; requestedBy: string }>;
  sessionId?: string;
  cart?: OrderCartItem[];
  subtotal?: number;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export const orderJobs = new Map<string, OrderJob>();

// ── Move events (Feature 5) ───────────────────────────────────────────────────

export type MovePhase =
  | "initiated"
  | "deposit_assessment"
  | "asset_split"
  | "utility_transfers"
  | "final_settlement"
  | "key_handover"
  | "completed";

export interface DepositDeduction {
  description: string;
  amount: number;
}

export interface SharedAsset {
  name: string;
  value: number;
  assignedTo?: string;
  decision?: "take" | "sell" | "leave";
}

export interface MoveEvent {
  id: string;
  chatId: string;
  type: "move_in" | "move_out";
  member: string;
  phase: MovePhase;
  targetDate: string;
  depositAmount?: number;
  depositDeductions: DepositDeduction[];
  sharedAssets: SharedAsset[];
  utilityTransferStatus: Record<string, "pending" | "done" | "skipped">;
  finalBalance?: number;
  createdAt: string;
  updatedAt: string;
}

export const moveEvents = new Map<string, MoveEvent>();

// ── Utility accounts / bills (Feature 4) ─────────────────────────────────────

export interface UtilityAccount {
  id: string;
  name: string;
  loginUrl: string;
  contextId: string;
  accountHolder: string;
  autopayEnabled: boolean;
  alertThresholdPct: number;
  createdAt: string;
}

export type BillStatus = "fetched" | "alerted" | "paid" | "skipped";

export interface UtilityBill {
  id: string;
  accountId: string;
  amount: number;
  dueDate?: string;
  periodStart?: string;
  periodEnd?: string;
  status: BillStatus;
  fetchedAt: string;
}

export const utilityAccounts = new Map<string, UtilityAccount>();
export const utilityBills = new Map<string, UtilityBill>();

// ── Helpers ───────────────────────────────────────────────────────────────────

export function money(n: number): string {
  const fixed = Math.abs(n).toFixed(2);
  return `$${fixed.endsWith(".00") ? fixed.slice(0, -3) : fixed}`;
}

function describeBalance(member: string, balance: number): string {
  if (balance > 0.005) return `${member} is owed ${money(balance)}`;
  if (balance < -0.005) return `${member} owes ${money(balance)}`;
  return `${member} is settled up`;
}

function daysAgo(iso: string, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000);
}

export function serializeState(s: HouseholdState = state, now: Date = new Date()): string {
  const lines: string[] = ["CURRENT HOUSEHOLD STATE:"];

  lines.push(`Members: ${s.members.length ? s.members.join(", ") : "(none configured yet)"}`);

  const balances = s.members.map((m) => describeBalance(m, s.balances[m] ?? 0));
  lines.push(`Balances: ${balances.length ? balances.join(", ") : "(none)"}`);

  const openGroceries = s.groceryList.filter((g) => !g.fulfilled);
  lines.push(
    `Grocery list: ${
      openGroceries.length
        ? openGroceries.map((g) => `${g.item} (${g.requestedBy})`).join(", ")
        : "(empty)"
    }`
  );
  if (s.lastGroceryRun) {
    lines.push(
      `Last grocery run: ${s.lastGroceryRun.slice(0, 10)} (${daysAgo(s.lastGroceryRun, now)} days ago)`
    );
  }

  const openChores = s.chores.filter((c) => !c.done);
  if (openChores.length) {
    lines.push(
      `Chores: ${openChores
        .map((c) => `${c.task} — ${c.assignee}${c.dueDate ? `, due ${c.dueDate}` : ""}`)
        .join("; ")}`
    );
  }

  const recent = s.ledger.slice(-5);
  if (recent.length) {
    lines.push(
      `Recent expenses: ${recent
        .map(
          (e) =>
            `${e.payer} paid ${money(e.amount)} for ${e.description} (split: ${e.split.join(", ")})`
        )
        .join("; ")}`
    );
  }

  const openItems = s.pendingItems.filter((i) => !i.resolved);
  if (openItems.length) {
    lines.push(
      `Open action items: ${openItems
        .map((i) => {
          const age = Math.floor((now.getTime() - Date.parse(i.raisedAt)) / 3_600_000);
          const dl = i.deadline ? `, due ${i.deadline.slice(11, 16)}` : "";
          return `"${i.description}" (${i.raisedBy}, ${age}h ago${dl})`;
        })
        .join("; ")}`
    );
  }

  const openMaintenance = [...maintenanceIssues.values()].filter(
    (i) => i.status !== "resolved"
  );
  if (openMaintenance.length) {
    lines.push(
      `Open maintenance: ${openMaintenance
        .map((i) => `${i.description} [${i.priority}] (${i.status})`)
        .join("; ")}`
    );
  }

  const facts = Object.entries(s.householdFacts);
  if (facts.length) {
    lines.push(`Household facts: ${facts.map(([k, v]) => `${k}: ${v}`).join("; ")}`);
  }

  lines.push(`Today: ${now.toISOString().slice(0, 10)}`);
  return lines.join("\n");
}
