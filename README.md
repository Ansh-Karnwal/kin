# 🔥 Hearth

**A household agent that lives in your group chat — and actually *does* the chores, not just tracks them.**

Hearth sits in a roommate group chat (Telegram), understands what's being said, and acts on it: splits expenses, orders the groceries, pays the bills, calls the landlord, reads receipts from photos, and nags the people who owe money — so no human has to be the one who asks.

---

## The idea

Most "household apps" are passive ledgers: you open an app, type what you spent, and it does math. Hearth is the opposite. It's **agent-native** — it lives where coordination already happens (the group chat) and turns intent into action.

> *"sink's leaking and rent's due friday"*
>
> → Hearth calls the landlord (pre-briefed with your unit number from its memory), books a repair window, drops it on the calendar, **and** fires off rent-split payment requests. Multiple real-world actions from one message, no app opened.

The moat is the **household graph**: every message enriches a memory of facts (`wifi_account → jake`, `maya_allergy → peanuts`, `lease_end → august 2026`). That context is what makes Hearth sound like a competent housemate instead of a chatbot.

---

## How it works

Hearth is a **hand-rolled tool-calling loop**, not a pipeline. Each message is handed to a model with a toolbox; the model decides which tools to call, chains them across steps, and only then replies.

```
Telegram group ──► Bridge ──► Agent (tool loop) ──► Tools ──► Bridge ──► Telegram group
                                   │
                                   ├─ classifier (is this relevant?)
                                   ├─ orchestrator (which tools? chain them)
                                   └─ household state injected every turn
```

- **Inference** runs on **[Nebius AI Studio](https://studio.nebius.com)** (OpenAI-compatible): a Qwen3-235B orchestrator for tool-calling, a small Qwen3-30B classifier/extractor, and Qwen2.5-VL for reading receipt photos.
- **State** is durable in **[Butterbase](https://butterbase.ai)** (members, balances, grocery list, facts, calendar, jobs). If Butterbase isn't configured, Hearth automatically falls back to an **in-memory store** so it runs fully offline.
- **Browser actions** (grocery ordering, bill portals) drive a cloud browser via **[Browserbase](https://browserbase.com) + Stagehand**.
- **Phone calls** go through **[Vapi](https://vapi.ai)**.
- **Web search** uses **[Perplexity](https://perplexity.ai)** Sonar when available.

### What Hearth can do

| Tier 1 — household logic | Tier 2 — real-world actions |
|---|---|
| `log_expense` / `get_balances` — split costs, track who owes who | `pay_bill` — fill a biller portal, stop for a "yes" before paying |
| `manage grocery list` (add/remove/compile) | `request_payment` — Venmo charge deeplinks for one-tap settle-up |
| `remember_fact` / `recall_fact` — the household graph | `order_household_supplies` — build a cart, screenshot, approve, checkout |
| `add_house_event` / calendar conflicts | `call_vendor` — call landlord/plumber/ISP/restaurant (pre-briefed) |
| `log_maintenance_issue` / draft landlord message | `parse_receipt` — read a receipt photo → ledger |
| `suggest_reorder` / move-in/out workflows | `web_search` — grounded vendor/price/bill lookups |
| `set_nag` — schedule a future nudge | proactive nags (rent due, stale debt, long grocery list) |

> 🔒 **Safety:** Hearth never spends money silently. Orders and bill payments always stop at a screenshot + an explicit in-chat "yes" before anything moves.

---

## Project layout

```
Hearth/
├── packages/
│   ├── agent/          # the brain: tool loop, tools, state, nag engine
│   │   └── src/
│   │       ├── index.ts        # express server: /chat, /callback, nags
│   │       ├── llm.ts          # Nebius client + tool-calling loop
│   │       ├── tools.ts        # tool schemas + dispatch
│   │       ├── db.ts           # Butterbase REST layer (+ in-memory fallback)
│   │       ├── billpay.ts, payments.ts, vision.ts, vendor.ts, search.ts …
│   │       └── prompts.ts      # persona + tone (banned words)
│   ├── bridge/         # Telegram Bot API ↔ agent (long-polling, photos, keyboards)
│   └── slack-bridge/   # optional Slack front-end
└── .env                # secrets (gitignored)
```

---

## Setup

### Prerequisites
- Node.js 20+ and npm
- A **Telegram bot** (free) and a group chat to add it to
- A **Nebius AI Studio** API key (required — all inference)
- *Optional:* Butterbase, Browserbase, Vapi, Perplexity keys (Hearth degrades gracefully without them)

### 1. Install
```bash
git clone https://github.com/Ansh-Karnwal/Hearth.git
cd Hearth
npm install
```

### 2. Configure `.env`
Copy the template and fill it in:
```bash
cp .env.example .env
```

**Minimum to run a demo** (everything else falls back or simulates):

| Key | What it's for |
|---|---|
| `NEBIUS_API_KEY` | All inference. Get it from the Nebius dashboard. |
| `NEBIUS_ORCHESTRATOR_MODEL` | e.g. `Qwen/Qwen3-235B-A22B-Instruct-2507` |
| `NEBIUS_FAST_MODEL` | e.g. `Qwen/Qwen3-30B-A3B-Instruct-2507` |
| `NEBIUS_VISION_MODEL` | e.g. `Qwen/Qwen2.5-VL-72B-Instruct` |
| `TELEGRAM_BOT_TOKEN` | From [@BotFather](https://t.me/botfather) → `/newbot` |
| `DEMO_MODE` | `true` (default) = fully simulate unconnected integrations |

**Optional integrations** (unlock real actions):

| Key | Unlocks |
|---|---|
| `BUTTERBASE_APP_ID` + `BUTTERBASE_API_KEY` | Durable state (else in-memory) |
| `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID` + `GEMINI_API_KEY` | Real grocery ordering / bill portals (Stagehand) |
| `VAPI_API_KEY` + `VAPI_PHONE_NUMBER_ID` | Real phone calls |
| `PERPLEXITY_API_KEY` | Grounded web search (else ungrounded Nebius) |

> **Demo vs. live:** `DEMO_MODE=true` makes bill pay, phone calls, grocery ordering, and utility checks fully *act out* the action with convincing confirmations and real ledger updates — no external service called, no "dry run" tells. Set `DEMO_MODE=false` only once Browserbase/Vapi are wired up.

### 3. Connect the Telegram group
Add your bot to a group, send any message in it, then capture the chat id:
```bash
npm run setup -w packages/bridge   # saves TARGET_CHAT_GUID to .env
```

### 4. Run
```bash
npm run dev    # starts bridge + agent (+ slack-bridge) together
```
You should see `[agent.started]` and the bridge begin polling. Message your group — Hearth replies when something touches its domains, or whenever you `@hearth` it.

```bash
npm run build  # typecheck / compile all packages
```

---

## Try it (3-minute demo)

Seed the house once:
```
hearth we're jake, maya, and sam
our unit is 4B, landlord is dave
```

**1. Grocery run — autonomous web action**
```
we're out of oat milk, paper towels, and coffee
do the grocery run
```
→ builds the cart, posts it with **Place order / Cancel** buttons → tap to checkout → cost split automatically.

**2. Call a vendor — voice**
```
call a plumber about the leaking sink
```
→ logs the issue, *"calling plumber now ☎️"*, then reports back a booked time and quote.

**3. Receipt photo — multimodal perception**
Send a photo of a receipt, caption `split this`
→ *"read it — trader joe's $63.40, logged and split even, $21.13 each"*, then ask `who owes what`.

---

## Tone

Hearth texts like a chill roommate: lowercase, brief, occasionally dry. It will never say "Certainly!" or "I have successfully completed your request." Tone rules (including banned words) live in [`packages/agent/src/prompts.ts`](packages/agent/src/prompts.ts).

---

## Tech / sponsor mapping

- **Nebius AI Studio** — all inference (classifier, orchestrator, graph extraction, receipt vision)
- **Browserbase + Stagehand** — grocery ordering, bill portals
- **Vapi** — phone calls
- **Butterbase** — durable household state
- **Perplexity** — grounded web search
- **Telegram Bot API** — the chat surface
