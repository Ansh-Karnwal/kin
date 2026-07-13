import { money } from "./state.js";
import type { MoveEvent, UtilityAccount } from "./state.js";
import {
  getMembers,
  getAllBalances,
  setMembers,
  setFact,
  getAllFacts,
  addUtilityAccount,
  getAllUtilityAccounts,
  getUtilityAccount,
  addMoveEvent,
  buildSerializedState,
} from "./db.js";
import { parseExpense, applyExpense, buildExpenseAck } from "./ledger.js";
import { applyGroceryIntent, formatGroceryList } from "./grocery.js";
import { logMaintenanceIssue, draftLandlordMessage, resolveIssue, getIssue } from "./maintenance.js";
import { addHouseEvent, getHouseCalendar, checkCalendarConflicts } from "./calendar.js";
import { suggestReorder } from "./reorder.js";
import { createOrderJob } from "./orders/jobs.js";
import { buildCart } from "./orders/browser.js";
import { log } from "./log.js";

export interface ToolContext {
  sender: string;
  chatId: string;
  bridgePort: number;
}

// ── Function declarations ─────────────────────────────────────────────────────

interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

const functionDeclarations: FunctionDeclaration[] = [
  // Ledger
  {
    name: "log_expense",
    description:
      "Record a shared expense and update balances. Use when someone says they paid for something shared (groceries, utilities, takeout, etc.).",
    parameters: {
      type: "object",
      properties: {
        payer: { type: "string", description: "who paid" },
        amount: { type: "number", description: "total amount paid" },
        description: { type: "string", description: "what the money was for" },
        split_type: {
          type: "string",
          enum: ["even", "item-attributed"],
          description: "even = equal split; item-attributed = specific costs to specific people",
        },
        beneficiaries: {
          type: "array",
          items: { type: "string" },
          description: "everyone who shares the cost, including the payer if applicable",
        },
      },
      required: ["payer", "amount", "description", "split_type", "beneficiaries"],
    },
  },

  // Balances
  {
    name: "get_balances",
    description: "Return current balances for all household members. Use when someone asks who owes what.",
    parameters: { type: "object", properties: {} },
  },

  // Grocery
  {
    name: "add_grocery_items",
    description:
      "Add one or more items to the shared grocery list. Use when someone says they need something or are out of something.",
    parameters: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "string" }, description: "item names, lowercase" },
        requested_by: { type: "string", description: "who requested the items" },
      },
      required: ["items", "requested_by"],
    },
  },
  {
    name: "remove_grocery_items",
    description: "Remove items from the grocery list (bought or no longer needed).",
    parameters: {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "string" } },
        action: { type: "string", enum: ["fulfill", "remove"], description: "fulfill = bought; remove = taken off without buying" },
      },
      required: ["items", "action"],
    },
  },
  {
    name: "get_grocery_list",
    description: "Return the current grocery list. Use when someone asks what's on the list.",
    parameters: { type: "object", properties: {} },
  },

  // Grocery ordering
  {
    name: "place_grocery_order",
    description:
      "Build the grocery list into a cart on Instacart, screenshot it, and send it to the house for approval before checking out. Use when someone says 'do the grocery run', 'order groceries', 'place the order'.",
    parameters: {
      type: "object",
      properties: {
        note: { type: "string", description: "optional instruction, e.g. 'split evenly this time'" },
      },
    },
  },

  // Action items
  {
    name: "add_action_item",
    description:
      "Log something that needs to be done but hasn't been assigned yet. Use for 'we should', 'someone needs to', 'can someone' messages.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string" },
        raised_by: { type: "string" },
        deadline: { type: "string", description: "ISO timestamp if a specific time was mentioned" },
      },
      required: ["description", "raised_by"],
    },
  },

  // Members
  {
    name: "set_members",
    description: "Set the list of household members. Call when someone asks to add, update, or configure who lives in the house.",
    parameters: {
      type: "object",
      properties: {
        names: {
          type: "array",
          items: { type: "string" },
          description: "Full list of household member names",
        },
      },
      required: ["names"],
    },
  },

  // Household facts
  {
    name: "set_household_fact",
    description: "Store a household fact (lease end date, landlord info, wifi password, etc.).",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "e.g. 'lease_end', 'landlord_name', 'wifi_password'" },
        value: { type: "string" },
      },
      required: ["key", "value"],
    },
  },
  {
    name: "get_household_facts",
    description: "Return all stored household facts.",
    parameters: { type: "object", properties: {} },
  },

  // Maintenance (F1)
  {
    name: "log_maintenance_issue",
    description:
      "Log a household maintenance issue. Detect priority: urgent for water/heat/gas/safety; medium for appliances/fixtures; low for cosmetic. Call when someone mentions something broken, leaking, not working, or needing repair.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string" },
        reported_by: { type: "string" },
        priority: { type: "string", enum: ["low", "medium", "urgent"] },
        photo_url: { type: "string", description: "Telegram file_id if a photo was attached" },
      },
      required: ["description", "reported_by", "priority"],
    },
  },
  {
    name: "draft_landlord_message",
    description:
      "Draft a professional maintenance message to the landlord, pulling in unit number, lease reference, and issue history.",
    parameters: {
      type: "object",
      properties: {
        issue_id: { type: "string" },
      },
      required: ["issue_id"],
    },
  },

  // Calendar (F2)
  {
    name: "add_house_event",
    description:
      "Add an event to the household calendar: repair windows, package arrivals, guests, trips, parties, lease dates, etc. Automatically add when grocery runs are scheduled or repairs booked.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        event_date: { type: "string", description: "ISO date YYYY-MM-DD" },
        event_time: { type: "string", description: "HH:MM 24h, optional" },
        duration_minutes: { type: "number" },
        all_day: { type: "boolean" },
        affects_members: { type: "array", items: { type: "string" } },
        event_type: {
          type: "string",
          enum: ["repair", "guest", "travel", "bill", "social", "move", "package", "other"],
        },
        notes: { type: "string" },
      },
      required: ["title", "event_date", "event_type"],
    },
  },
  {
    name: "get_house_calendar",
    description: "Return upcoming household events for the next N days.",
    parameters: {
      type: "object",
      properties: {
        days: { type: "number", description: "default 7" },
      },
    },
  },
  {
    name: "check_calendar_conflicts",
    description:
      "Check if a proposed event conflicts with existing calendar entries. Use before confirming repair windows, guest visits, or house events.",
    parameters: {
      type: "object",
      properties: {
        event_date: { type: "string" },
        event_time: { type: "string" },
        duration_minutes: { type: "number" },
        affects_members: { type: "array", items: { type: "string" } },
      },
      required: ["event_date"],
    },
  },

  // Smart reorder (F3)
  {
    name: "suggest_reorder",
    description:
      "Check consumption patterns and proactively suggest reordering items likely running low. Call when someone mentions being out of something, or on the daily scheduled check.",
    parameters: {
      type: "object",
      properties: {
        triggered_by: { type: "string", enum: ["mention", "scheduled"] },
        item_mentioned: { type: "string", description: "the specific item mentioned if triggered_by is mention" },
      },
      required: ["triggered_by"],
    },
  },

  // Move mode (F5)
  {
    name: "initiate_move",
    description:
      "Start a move-in or move-out workflow. Triggered when someone mentions a roommate leaving or a new one joining.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["move_in", "move_out"] },
        member: { type: "string", description: "name of the person moving" },
        target_date: { type: "string", description: "ISO date of the move" },
      },
      required: ["type", "member", "target_date"],
    },
  },

  // Utility monitor (F4)
  {
    name: "check_utility_bills",
    description:
      "Log into utility portals via cloud browser, extract current bills, compare to last month, and alert on spikes. Run on schedule or when someone asks about a bill.",
    parameters: {
      type: "object",
      properties: {
        account_id: { type: "string", description: "specific account UUID; omit for all accounts" },
      },
    },
  },
  {
    name: "add_utility_account",
    description: "Register a new utility account for monitoring (PG&E, Comcast, water, etc.).",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "e.g. 'PG&E'" },
        login_url: { type: "string" },
        account_holder: { type: "string" },
        context_id: { type: "string", description: "Browserbase persistent context ID" },
        alert_threshold_pct: { type: "number", description: "alert if bill increases by this %, default 15" },
      },
      required: ["name", "login_url", "account_holder", "context_id"],
    },
  },
];

/** OpenAI tool format: wrap each declaration in { type: "function", function: ... } */
export const toolDeclarations = functionDeclarations.map((d) => ({
  type: "function" as const,
  function: d,
}));

// ── Dispatch ──────────────────────────────────────────────────────────────────

type DispatchResult = Record<string, unknown> | string | null;

/** Create a bound dispatch function for the given request context. */
export function createDispatch(ctx: ToolContext) {
  return async function dispatch(
    name: string,
    args: Record<string, unknown>
  ): Promise<DispatchResult> {
    log("tool.dispatch", { name, sender: ctx.sender, chatId: ctx.chatId });

    switch (name) {
      // ── Ledger ──────────────────────────────────────────────────────────────
      case "log_expense": {
        const text = `${args.payer} paid ${args.amount} for ${args.description}`;
        const expense = await parseExpense(text, ctx.sender);
        if (expense) {
          await applyExpense(expense);
          return { ack: await buildExpenseAck(expense) };
        }
        const members = await getMembers();
        const directExpense = {
          payer: String(args.payer ?? ctx.sender),
          amount: Number(args.amount ?? 0),
          description: String(args.description ?? "shared expense"),
          splitType: (args.split_type === "even" ? "even" : "item-attributed") as "even" | "item-attributed",
          beneficiaries: Array.isArray(args.beneficiaries)
            ? (args.beneficiaries as string[])
            : members,
        };
        await applyExpense(directExpense);
        return { ack: await buildExpenseAck(directExpense) };
      }

      case "get_balances": {
        const [members, balances] = await Promise.all([getMembers(), getAllBalances()]);
        const result = Object.fromEntries(members.map((m) => [m, balances[m] ?? 0]));
        const summary = members
          .map((m) => {
            const b = balances[m] ?? 0;
            if (b > 0.005) return `${m} is owed ${money(b)}`;
            if (b < -0.005) return `${m} owes ${money(Math.abs(b))}`;
            return `${m} is settled up`;
          })
          .join(", ");
        return { balances: result, summary };
      }

      // ── Grocery ─────────────────────────────────────────────────────────────
      case "add_grocery_items": {
        const items = Array.isArray(args.items) ? (args.items as string[]) : [];
        const requestedBy = String(args.requested_by ?? ctx.sender);
        const ack = await applyGroceryIntent({ action: "add", items, requestedBy });
        return { ack };
      }

      case "remove_grocery_items": {
        const items = Array.isArray(args.items) ? (args.items as string[]) : [];
        const action = args.action === "remove" ? "remove" : "fulfill";
        const ack = await applyGroceryIntent({ action, items, requestedBy: ctx.sender });
        return { ack };
      }

      case "get_grocery_list": {
        return { list: await formatGroceryList() };
      }

      // ── Grocery ordering ────────────────────────────────────────────────────
      case "place_grocery_order": {
        const note = args.note ? String(args.note) : undefined;
        const job = await createOrderJob(ctx.chatId, note);
        if (!job) return { error: "grocery list is empty — add some items first" };

        void buildCart(job.id, ctx.bridgePort);

        return {
          status: "started",
          jobId: job.id,
          itemCount: job.items.length,
          ack: `on it — building your cart now, give me a sec 🛒`,
        };
      }

      // ── Action items ─────────────────────────────────────────────────────────
      case "add_action_item": {
        const { addPendingItem } = await import("./db.js");
        const item = {
          id: crypto.randomUUID(),
          description: String(args.description ?? ""),
          raisedBy: String(args.raised_by ?? ctx.sender),
          raisedAt: new Date().toISOString(),
          deadline: args.deadline ? String(args.deadline) : undefined,
          resolved: false,
        };
        await addPendingItem(item);
        const timeHint = item.deadline
          ? ` — i'll check back if no one's on it by ${new Date(item.deadline).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
          : "";
        return { ack: `noted${timeHint}` };
      }

      // ── Members ──────────────────────────────────────────────────────────────
      case "set_members": {
        const names = (args.names as string[] | undefined)?.map(String).filter(Boolean) ?? [];
        if (names.length === 0) return { error: "names required" };
        await setMembers(names);
        return { ack: `members set: ${names.join(", ")}` };
      }

      // ── Household facts ──────────────────────────────────────────────────────
      case "set_household_fact": {
        const key = String(args.key ?? "");
        const value = String(args.value ?? "");
        if (!key) return { error: "key required" };
        await setFact(key, value);
        return { ack: `got it — saved ${key}` };
      }

      case "get_household_facts": {
        return { facts: await getAllFacts() };
      }

      // ── Maintenance ──────────────────────────────────────────────────────────
      case "log_maintenance_issue": {
        const result = await logMaintenanceIssue({
          description: String(args.description ?? ""),
          reported_by: String(args.reported_by ?? ctx.sender),
          priority: (args.priority as "low" | "medium" | "urgent") ?? "medium",
          photo_url: args.photo_url ? String(args.photo_url) : undefined,
        });
        if (result.keyboard.length > 0) {
          void fetch(`http://localhost:${ctx.bridgePort}/send-keyboard`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chatId: ctx.chatId, message: result.message, keyboard: result.keyboard }),
          });
          return { ack: result.message, issueId: result.issueId, _keyboard_sent: true };
        }
        return { ack: result.message, issueId: result.issueId };
      }

      case "draft_landlord_message": {
        const result = await draftLandlordMessage({ issue_id: String(args.issue_id ?? "") });
        if (result.keyboard.length > 0) {
          void fetch(`http://localhost:${ctx.bridgePort}/send-keyboard`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chatId: ctx.chatId, message: result.message, keyboard: result.keyboard }),
          });
        }
        return { message: result.message, draft: result.draft };
      }

      // ── Calendar ─────────────────────────────────────────────────────────────
      case "add_house_event": {
        const result = await addHouseEvent({
          title: String(args.title ?? ""),
          event_date: String(args.event_date ?? ""),
          event_time: args.event_time ? String(args.event_time) : undefined,
          duration_minutes: args.duration_minutes ? Number(args.duration_minutes) : undefined,
          all_day: args.all_day === true,
          affects_members: Array.isArray(args.affects_members)
            ? (args.affects_members as string[])
            : [],
          event_type: String(args.event_type ?? "other") as "other",
          notes: args.notes ? String(args.notes) : undefined,
          created_by: ctx.sender,
        });
        return result;
      }

      case "get_house_calendar": {
        const days = args.days ? Number(args.days) : 7;
        return { calendar: await getHouseCalendar({ days }) };
      }

      case "check_calendar_conflicts": {
        const conflicts = await checkCalendarConflicts({
          event_date: String(args.event_date ?? ""),
          event_time: args.event_time ? String(args.event_time) : undefined,
          duration_minutes: args.duration_minutes ? Number(args.duration_minutes) : undefined,
          affects_members: Array.isArray(args.affects_members)
            ? (args.affects_members as string[])
            : undefined,
        });
        return { conflicts, hasConflicts: conflicts.length > 0 };
      }

      // ── Reorder ──────────────────────────────────────────────────────────────
      case "suggest_reorder": {
        const result = await suggestReorder({
          triggered_by: args.triggered_by as "mention" | "scheduled",
          item_mentioned: args.item_mentioned ? String(args.item_mentioned) : undefined,
        });
        if (result.keyboard.length > 0 && result.suggestions.length > 0) {
          void fetch(`http://localhost:${ctx.bridgePort}/send-keyboard`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chatId: ctx.chatId, message: result.message, keyboard: result.keyboard }),
          });
          return { suggestions: result.suggestions, _keyboard_sent: true };
        }
        return { suggestions: result.suggestions, message: result.message };
      }

      // ── Move mode ────────────────────────────────────────────────────────────
      case "initiate_move": {
        return initiateMove({
          type: args.type as "move_in" | "move_out",
          member: String(args.member ?? ""),
          target_date: String(args.target_date ?? ""),
          chatId: ctx.chatId,
          bridgePort: ctx.bridgePort,
        });
      }

      // ── Utility monitor ───────────────────────────────────────────────────────
      case "add_utility_account": {
        const id = crypto.randomUUID();
        const account: UtilityAccount = {
          id,
          name: String(args.name ?? ""),
          loginUrl: String(args.login_url ?? ""),
          contextId: String(args.context_id ?? ""),
          accountHolder: String(args.account_holder ?? ""),
          autopayEnabled: false,
          alertThresholdPct: Number(args.alert_threshold_pct ?? 15),
          createdAt: new Date().toISOString(),
        };
        await addUtilityAccount(account);
        log("utility.account_added", { id, name: account.name, holder: account.accountHolder });
        return { ack: `added ${account.name} under ${account.accountHolder}`, accountId: id };
      }

      case "check_utility_bills": {
        const accountId = args.account_id ? String(args.account_id) : undefined;
        return checkUtilityBills(accountId, ctx);
      }

      default:
        log("tool.unknown", { name });
        return { error: `unknown tool: ${name}` };
    }
  };
}

// ── Move mode helpers ─────────────────────────────────────────────────────────

async function initiateMove(args: {
  type: "move_in" | "move_out";
  member: string;
  target_date: string;
  chatId: string;
  bridgePort: number;
}): Promise<DispatchResult> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const event: MoveEvent = {
    id,
    chatId: args.chatId,
    type: args.type,
    member: args.member,
    phase: "initiated",
    targetDate: args.target_date,
    depositDeductions: [],
    sharedAssets: [],
    utilityTransferStatus: {},
    createdAt: now,
    updatedAt: now,
  };

  await addMoveEvent(event);
  log("move.initiated", { id, type: args.type, member: args.member, targetDate: args.target_date });

  const verb = args.type === "move_out" ? "moving out" : "moving in";
  const firstStep =
    args.type === "move_out"
      ? "let's sort the deposit first — anyone have damage to flag beyond normal wear? share a photo if so."
      : `welcome to the house, ${args.member.toLowerCase()} 🏠 let's get you set up.`;

  void fetch(`http://localhost:${args.bridgePort}/send-keyboard`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chatId: args.chatId,
      message: `ok, ${args.member.toLowerCase()} is ${verb} ${args.target_date}. ${firstStep}`,
      keyboard: [[
        args.type === "move_out"
          ? { text: "Full deposit back", callback_data: `move:deposit_full:${id}` }
          : { text: "All set", callback_data: `move:onboard_done:${id}` },
        args.type === "move_out"
          ? { text: "Deduct damages", callback_data: `move:deposit_deduct:${id}` }
          : { text: "Set rent share", callback_data: `move:set_rent:${id}` },
      ]],
    }),
  });

  return {
    moveId: id,
    ack: `started ${args.type.replace("_", "-")} workflow for ${args.member}`,
    _keyboard_sent: true,
  };
}

// ── Utility bill check ────────────────────────────────────────────────────────

async function checkUtilityBills(
  accountId: string | undefined,
  ctx: ToolContext
): Promise<DispatchResult> {
  const accounts = accountId
    ? [await getUtilityAccount(accountId)].filter(Boolean)
    : await getAllUtilityAccounts();

  if (accounts.length === 0) {
    return { message: "no utility accounts configured. use 'add utility account' first" };
  }

  if (!process.env.BROWSERBASE_API_KEY) {
    return { message: "utility checking requires BROWSERBASE_API_KEY to be set" };
  }

  log("utility.check_triggered", { accountCount: accounts.length, chatId: ctx.chatId });

  for (const account of accounts as UtilityAccount[]) {
    void runUtilityBrowserJob(account, ctx);
  }

  return {
    status: "started",
    accountCount: accounts.length,
    ack: "checking utility bills now — i'll post any updates here",
  };
}

async function runUtilityBrowserJob(
  account: UtilityAccount,
  ctx: ToolContext
): Promise<void> {
  const { addUtilityBill, getBillsForAccount, patchUtilityBill } = await import("./db.js");

  const sendUpdate = async (msg: string) => {
    await fetch(`http://localhost:${ctx.bridgePort}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: ctx.chatId, message: msg }),
    });
  };

  try {
    const { Stagehand } = await import("@browserbasehq/stagehand");
    const { z } = await import("zod");

    const stagehand = new Stagehand({
      env: "BROWSERBASE",
      apiKey: process.env.BROWSERBASE_API_KEY,
      projectId: process.env.BROWSERBASE_PROJECT_ID,
      model: {
        modelName: "gemini-2.5-flash-preview-04-17" as const,
        apiKey: process.env.GEMINI_API_KEY,
      },
      browserbaseSessionCreateParams: {
        projectId: process.env.BROWSERBASE_PROJECT_ID!,
        keepAlive: false,
        browserSettings: { context: { id: account.contextId, persist: true } } as Record<string, unknown>,
      },
    });

    await stagehand.init();

    const heartbeat = setTimeout(() => {
      void sendUpdate(`still checking ${account.name}...`);
    }, 120_000);

    try {
      await stagehand.act(`navigate to ${account.loginUrl}`);

      const BillSchema = z.object({
        amount: z.number(),
        dueDate: z.string().optional(),
        periodStart: z.string().optional(),
        periodEnd: z.string().optional(),
      });

      const extracted = await stagehand.extract(
        "extract the current bill amount, due date, billing period start and end date",
        BillSchema
      );

      clearTimeout(heartbeat);

      const billId = crypto.randomUUID();
      const newBill = {
        id: billId,
        accountId: account.id,
        amount: extracted.amount,
        dueDate: extracted.dueDate,
        periodStart: extracted.periodStart,
        periodEnd: extracted.periodEnd,
        status: "fetched" as const,
        fetchedAt: new Date().toISOString(),
      };

      await addUtilityBill(newBill);

      const prevBills = await getBillsForAccount(account.id);
      const prevBill = prevBills.find((b) => b.id !== billId);

      if (prevBill) {
        const delta = extracted.amount - prevBill.amount;
        const pct = Math.round((delta / prevBill.amount) * 100);

        if (Math.abs(pct) >= account.alertThresholdPct && delta > 0) {
          await patchUtilityBill(billId, { status: "alerted" });
          const msg = `⚡ ${account.name} bill is $${extracted.amount.toFixed(2)} this month — $${delta.toFixed(2)} more than last month (+${pct}%). want me to investigate why, or just split it?`;

          await fetch(`http://localhost:${ctx.bridgePort}/send-keyboard`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chatId: ctx.chatId,
              message: msg,
              keyboard: [[
                { text: "Split it", callback_data: `utility:split:${billId}` },
                { text: "Investigate", callback_data: `utility:investigate:${billId}` },
                { text: "Snooze", callback_data: `utility:snooze:${billId}` },
              ]],
            }),
          });
          log("utility.spike_alert", { accountId: account.id, amount: extracted.amount, pct });
        } else {
          await sendUpdate(`${account.name}: $${extracted.amount.toFixed(2)} — same as usual`);
        }
      } else {
        await sendUpdate(`${account.name}: $${extracted.amount.toFixed(2)} (first reading)`);
      }

      await stagehand.close();
    } catch (inner) {
      clearTimeout(heartbeat);
      throw inner;
    }
  } catch (err) {
    log("utility.browser_failed", { accountId: account.id, error: String(err) });
    await sendUpdate(
      `ran into a problem with the ${account.name} portal — you may need to handle that one manually.`
    );
  }
}
