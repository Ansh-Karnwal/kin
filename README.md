# Hearth

*****A household operations agent that lives inside your group chat.***

**A household operations agent that lives inside your group chat.**

Hearth sits in a roommate or household group chat, understands what people are coordinating, and helps turn those messages into action: splitting expenses, managing groceries, tracking bills, calling vendors, reading receipts, and following up on unpaid balances.

Instead of asking one person to remember everything, Hearth becomes the shared household coordinator.

---

## Overview

Most household apps are passive trackers. Someone still has to open an app, enter an expense, update a grocery list, or remind a roommate to pay them back.

Hearth works differently. It lives where household coordination already happens: the group chat.

For example:

> “sink’s leaking and rent’s due friday”

Hearth can use the household context it already knows — unit number, landlord, roommates, balances, and recurring bills — to log the maintenance issue, prepare or place a landlord call, schedule a repair window, and start the rent split.

The core idea is a persistent **household context graph**. Over time, Hearth builds memory around facts like:

* `wifi_account → jake`
* `maya_allergy → peanuts`
* `lease_end → august 2026`
* `landlord → dave`
* `rent_due → friday`

That shared context lets Hearth behave less like a chatbot and more like a reliable housemate who understands how the household works.

---

## How it works

Hearth is built around a hand-rolled tool-calling loop.

Each incoming message is passed to a model with access to household state and a set of tools. The model decides whether the message is relevant, which tools to call, whether to chain multiple actions together, and how to respond back in the group chat.

```text
Telegram group ──► Bridge ──► Agent/tool loop ──► Tools ──► Bridge ──► Telegram group
                                   │
                                   ├─ relevance classifier
                                   ├─ tool orchestrator
                                   └─ household state injected every turn
```

### Core components

* **Telegram bridge**
  Connects the household group chat to the agent.

* **Agent runtime**
  Runs the tool-calling loop, injects household state, and coordinates actions.

* **State layer**
  Stores members, balances, grocery lists, facts, calendar events, jobs, and maintenance history.

* **Action tools**
  Handle expenses, groceries, bill payment flows, receipt parsing, vendor calls, web lookups, and scheduled reminders.

---

## Capabilities

### Household coordination

| Capability           | Description                                                  |
| -------------------- | ------------------------------------------------------------ |
| Expense tracking     | Log shared expenses, split costs, and show balances          |
| Grocery management   | Add, remove, compile, and prepare grocery runs               |
| Household memory     | Remember and recall facts about the household                |
| Calendar events      | Add house events and check conflicts                         |
| Maintenance tracking | Log issues and draft landlord/vendor messages                |
| Reorder suggestions  | Suggest recurring household supplies                         |
| Nags and reminders   | Schedule future nudges for bills, chores, or unpaid balances |

### Real-world actions

| Capability        | Description                                                          |
| ----------------- | -------------------------------------------------------------------- |
| Bill payment flow | Navigate biller portals and stop for approval before payment         |
| Payment requests  | Generate Venmo-style payment request links                           |
| Grocery ordering  | Build carts, show screenshots, and wait for approval before checkout |
| Vendor calls      | Call landlords, plumbers, ISPs, restaurants, or other vendors        |
| Receipt parsing   | Read receipt photos and convert them into ledger entries             |
| Web search        | Look up vendors, prices, biller information, or household questions  |

---

## Safety model

Hearth does not spend money without approval.

For actions such as bill payments or grocery orders, Hearth stops before checkout, posts a screenshot or summary in the chat, and waits for an explicit confirmation before proceeding.

Demo mode also simulates external actions safely, allowing the project to be shown end-to-end without placing real orders, making real payments, or calling live services.

---

## Tech stack

* **Nebius AI Studio** — inference for orchestration, classification, extraction, and receipt vision
* **Butterbase** — durable household state
* **Browserbase + Stagehand** — browser automation for grocery ordering and bill portals
* **Vapi** — phone calls to vendors and service providers
* **Perplexity Sonar** — grounded web search
* **Telegram Bot API** — group chat interface
* **Slack bridge** — optional alternate frontend

---

## Project structure

```text
Hearth/
├── packages/
│   ├── agent/
│   │   └── src/
│   │       ├── index.ts        # Express server: /chat, /callback, nags
│   │       ├── llm.ts          # Nebius client and tool-calling loop
│   │       ├── tools.ts        # Tool schemas and dispatch
│   │       ├── db.ts           # Butterbase REST layer with in-memory fallback
│   │       ├── billpay.ts      # Bill payment flows
│   │       ├── payments.ts     # Payment request logic
│   │       ├── vision.ts       # Receipt parsing
│   │       ├── vendor.ts       # Vendor call flows
│   │       ├── search.ts       # Web search
│   │       └── prompts.ts      # Hearth persona and tone rules
│   ├── bridge/                 # Telegram Bot API bridge
│   └── slack-bridge/           # Optional Slack frontend
└── .env                        # Local secrets and configuration
```

---

## Setup

### Prerequisites

* Node.js 20+
* npm
* A Telegram bot
* A Telegram group chat
* A Nebius AI Studio API key

Optional integrations:

* Butterbase
* Browserbase
* Vapi
* Perplexity

Hearth can run without the optional integrations. When those services are not configured, it falls back to in-memory state or simulated actions where appropriate.

---

## Installation

```bash
git clone https://github.com/Ansh-Karnwal/Hearth.git
cd Hearth
npm install
```

---

## Environment variables

Copy the example environment file:

```bash
cp .env.example .env
```

### Minimum required configuration

| Key                         | Description                                                                |
| --------------------------- | -------------------------------------------------------------------------- |
| `NEBIUS_API_KEY`            | Required for all inference                                                 |
| `NEBIUS_ORCHESTRATOR_MODEL` | Orchestrator model, for example `Qwen/Qwen3-235B-A22B-Instruct-2507`       |
| `NEBIUS_FAST_MODEL`         | Classifier/extractor model, for example `Qwen/Qwen3-30B-A3B-Instruct-2507` |
| `NEBIUS_VISION_MODEL`       | Vision model, for example `Qwen/Qwen2.5-VL-72B-Instruct`                   |
| `TELEGRAM_BOT_TOKEN`        | Telegram bot token from BotFather                                          |
| `DEMO_MODE`                 | `true` by default; simulates external actions safely                       |

### Optional integrations

| Key                                                                 | Enables                                       |
| ------------------------------------------------------------------- | --------------------------------------------- |
| `BUTTERBASE_APP_ID` + `BUTTERBASE_API_KEY`                          | Durable household state                       |
| `BROWSERBASE_API_KEY` + `BROWSERBASE_PROJECT_ID` + `GEMINI_API_KEY` | Browser automation for carts and bill portals |
| `VAPI_API_KEY` + `VAPI_PHONE_NUMBER_ID`                             | Live vendor calls                             |
| `PERPLEXITY_API_KEY`                                                | Grounded web search                           |

---

## Connect Telegram

Add your bot to a Telegram group, send a message in the group, then run:

```bash
npm run setup -w packages/bridge
```

This saves the target chat ID to your `.env` file.

---

## Run locally

```bash
npm run dev
```

This starts the agent, Telegram bridge, and optional Slack bridge.

You should see the agent start successfully and the bridge begin polling for messages.

To build and typecheck:

```bash
npm run build
```

---

## Demo script

Seed the household once:

```text
hearth we're jake, maya, and sam
our unit is 4B, landlord is dave
```

### 1. Grocery run

```text
we're out of oat milk, paper towels, and coffee
do the grocery run
```

Expected behavior:

* Hearth compiles the grocery list
* Builds a cart
* Posts a summary or screenshot
* Waits for approval
* Splits the cost after checkout or simulated checkout

### 2. Vendor call

```text
call a plumber about the leaking sink
```

Expected behavior:

* Hearth logs the maintenance issue
* Uses household context to brief the call
* Starts or simulates the vendor call
* Reports the result back to the group chat

### 3. Receipt parsing

Send a receipt photo with the caption:

```text
split this
```

Expected behavior:

* Hearth reads the receipt
* Extracts merchant and total
* Logs the expense
* Splits the cost across household members
* Updates balances

Then ask:

```text
who owes what
```

---

## Demo mode vs. live mode

`DEMO_MODE=true` is the safest way to run Hearth during demos.

In demo mode:

* External calls are simulated
* Bill payments do not move money
* Grocery orders are not actually placed
* Vendor calls can be mocked
* Ledger and household state still update normally

Set `DEMO_MODE=false` only after the relevant live integrations are configured and tested.

---

## Tone

Hearth responds like a helpful roommate: brief, casual, and direct.

The tone rules live in:

```text
packages/agent/src/prompts.ts
```

The goal is to keep responses useful in a real group chat without sounding like a generic assistant.

---

## Sponsor integration map

| Sponsor / platform      | How Hearth uses it                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| Nebius AI Studio        | Runs the classifier, orchestrator, graph extraction, and receipt vision models               |
| Butterbase              | Stores durable household state, including balances, facts, grocery lists, and scheduled jobs |
| Browserbase + Stagehand | Drives browser-based workflows such as grocery ordering and bill payment portals             |
| Vapi                    | Places phone calls to landlords, plumbers, ISPs, and other household vendors                 |
| Perplexity              | Provides grounded web search for vendor, pricing, and bill-related lookups                   |
| Telegram Bot API        | Provides the primary group chat interface                                                    |

---

## License

This project is licensed under the [MIT License](LICENSE).
