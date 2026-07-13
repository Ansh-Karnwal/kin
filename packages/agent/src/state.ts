// ── Type definitions only — all runtime state lives in Butterbase (db.ts) ──────

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

// ── Consumption patterns (Feature 3) ─────────────────────────────────────────

export interface ConsumptionPattern {
  id: string;
  itemName: string;
  avgDaysBetweenOrders?: number;
  lastOrderedAt: string;
  timesOrdered: number;
  typicalRequesters: string[];
  updatedAt: string;
}

// ── Order jobs (grocery ordering) ─────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

export function money(n: number): string {
  const fixed = Math.abs(n).toFixed(2);
  return `$${fixed.endsWith(".00") ? fixed.slice(0, -3) : fixed}`;
}
