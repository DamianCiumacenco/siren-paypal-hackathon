# Siren — Architecture & Build Plan (v3)

Target audience: Claude Code (or any build-AI). Everything needed to generate the full codebase lives here. Reframed around the official **PayPal Agent Toolkit** + **Vercel AI SDK** — not hand-rolled.

---

## Stack (locked)

- **Runtime**: Node.js 22 LTS + TypeScript (strict)
- **Framework**: Fastify 5
- **Telegram**: `grammy`
- **Agent engine**: Vercel AI SDK (`ai` npm pkg) — provides `generateText({ tools, stopWhen })` which IS the agent loop; no hand-rolled loop needed
- **PayPal tools**: `@paypal/agent-toolkit/ai-sdk` — official toolkit, pre-wired PayPal tools for function-calling (invoicing, orders, subscriptions, disputes, shipment tracking)
- **LLM providers**: `@ai-sdk/groq` primary (`openai/gpt-oss-120b`), `@ai-sdk/google` fallback (`gemini-2.5-flash`)
- **DB**: Supabase (hosted Postgres) via `@supabase/supabase-js`
- **Scheduler**: `node-cron` for the autonomous 6h runner
- **Validation**: `zod`
- **Deploy**: Render Web Service
- **Dashboard (optional)**: single `/dashboard` HTML page served by Fastify

---

## Why this stack

1. **PayPal Agent Toolkit** = official PayPal-sanctioned path. Judge criterion "thorough and skillful use of PayPal Developer Platform" is literally met by importing their toolkit. Judges see "built on PayPal's own AI tooling" = max credibility.
2. **Vercel AI SDK** `generateText({ tools, stopWhen })` handles multi-step tool-calling natively. No custom loop code. Battle-tested, typed, supports streaming + telemetry.
3. **Groq via `@ai-sdk/groq`** = one-line provider swap, free tier, fast enough for interactive demo.
4. **Grammy** = modern Telegram wrapper, typed, async-friendly, way nicer than node-telegram-bot-api.

---

## File structure

```
siren/
├── src/
│   ├── agent/                       # the brain
│   │   ├── run.ts                   # single entry: runAgent(input) → wraps generateText
│   │   ├── system-prompt.ts         # system prompt builder (context-aware)
│   │   ├── tools/                   # custom tools (PayPal tools come from toolkit)
│   │   │   ├── index.ts             # merge PayPal toolkit tools + custom tools
│   │   │   ├── fetch_group_history.ts
│   │   │   ├── get_member_profile.ts
│   │   │   ├── remember_preference.ts
│   │   │   ├── schedule_followup.ts
│   │   │   ├── summarise_debt.ts
│   │   │   └── telegram_dm.ts       # send DM to a group member
│   │   └── reasoning-log.ts         # persist chain-of-thought
│   ├── bot/
│   │   ├── index.ts                 # grammy setup, webhook mount
│   │   ├── commands.ts              # /start /split /status /nag /help /siren ...
│   │   ├── middleware.ts            # group auto-register, user resolve
│   │   └── handlers/
│   │       ├── message.ts           # free-text → agent
│   │       └── callback.ts          # inline-button taps (confirm/cancel split)
│   ├── llm/
│   │   ├── providers.ts             # Groq primary, Gemini fallback — model factory
│   │   └── cache.ts                 # 1h cache on identical prompts
│   ├── paypal/
│   │   ├── toolkit.ts               # init PayPalAgentToolkit, export tool list
│   │   └── webhooks.ts              # sig verify + dispatch (NOT in agent toolkit — we own this)
│   ├── memory/
│   │   ├── profile.ts               # read/write user_memory
│   │   ├── scoring.ts               # reliability score calc
│   │   └── tone.ts                  # pick reminder tone from profile
│   ├── scheduler/
│   │   └── runner.ts                # cron: every 6h, iterate open splits, invoke agent
│   ├── db/
│   │   ├── schema.sql
│   │   ├── client.ts
│   │   ├── groups.ts
│   │   ├── users.ts
│   │   ├── splits.ts
│   │   ├── split_members.ts
│   │   ├── user_memory.ts
│   │   └── reasoning_log.ts
│   ├── routes/
│   │   ├── telegram.ts              # POST /webhook/telegram
│   │   ├── paypal.ts                # POST /webhook/paypal
│   │   ├── dashboard.ts             # GET /dashboard (optional)
│   │   └── health.ts                # GET /health
│   ├── config.ts
│   └── server.ts
├── test/
│   ├── agent.test.ts                # mocked generateText, assert correct tool sequence
│   └── parser-cases.test.ts         # 20+ sample messages → expected tool calls
├── public/                           # dashboard assets (optional)
├── .env.example
├── .gitignore
├── render.yaml
├── package.json
├── tsconfig.json
├── CLAUDE.md                         # auto-read context for Claude Code
├── README.md
└── LICENSE                           # MIT
```

---

## Key dependencies (`package.json`)

> **Pinned (milestone 1):** exact versions live in `package.json`; the block below is the original intent. Notes: `ai` v7 + `@ai-sdk/*` v4 + `@supabase/supabase-js` require Node ≥22 (hence Node 22 LTS). `@paypal/agent-toolkit@1.11.0` bundles its own `ai@4` and emits v4-style tools (`parameters`), so milestone 3/5 needs a thin adapter to `inputSchema` for ai v7. `vitest` pinned to 4.0.18 (4.1.x triggers an npm 10 peer-resolution crash).

```json
{
  "dependencies": {
    "@paypal/agent-toolkit": "latest",
    "ai": "latest",
    "@ai-sdk/groq": "latest",
    "@ai-sdk/google": "latest",
    "grammy": "latest",
    "fastify": "^5.0.0",
    "@supabase/supabase-js": "latest",
    "node-cron": "latest",
    "zod": "latest"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "tsx": "latest",
    "vitest": "latest",
    "@types/node": "^22.0.0"
  }
}
```

---

## Data model (Supabase SQL — `src/db/schema.sql`)

```sql
create table groups (
  id                bigserial primary key,
  telegram_chat_id  bigint unique not null,
  chat_title        text,
  created_by        bigint,
  created_at        timestamptz default now()
);

create table users (
  id                bigserial primary key,
  telegram_user_id  bigint unique not null,
  username          text,
  first_name        text,
  paypal_email      text,
  created_at        timestamptz default now()
);

create table splits (
  id                uuid primary key default gen_random_uuid(),
  group_id          bigint references groups(id) on delete cascade,
  creator_user_id   bigint references users(id),
  description       text,
  total_amount      numeric(10,2),
  currency          text default 'EUR' check (currency in ('EUR','USD','GBP')),
  per_person_amount numeric(10,2),
  status            text default 'open' check (status in ('open','settled','cancelled')),
  next_nag_at       timestamptz,                -- set by schedule_followup tool
  created_at        timestamptz default now()
);

create table split_members (
  id                uuid primary key default gen_random_uuid(),
  split_id          uuid references splits(id) on delete cascade,
  user_id           bigint references users(id),
  display_name      text not null,
  paypal_invoice_id text,
  payment_link      text,
  status            text default 'pending' check (status in ('pending','sent','paid','failed','cancelled')),
  paid_at           timestamptz,
  reminders_sent    int default 0,
  last_reminded_at  timestamptz
);

create table user_memory (
  id                uuid primary key default gen_random_uuid(),
  user_id           bigint references users(id) on delete cascade,
  group_id          bigint references groups(id) on delete cascade,
  avg_hours_to_pay  numeric,
  reliability_score numeric,
  preferred_tone    text default 'neutral' check (preferred_tone in ('chill','neutral','direct')),
  total_splits      int default 0,
  total_paid_ontime int default 0,
  notes             text,
  updated_at        timestamptz default now(),
  unique (user_id, group_id)
);

create table reasoning_log (
  id             bigserial primary key,
  group_id       bigint references groups(id) on delete cascade,
  split_id       uuid references splits(id) on delete set null,
  trigger        text,                        -- 'user_message' | 'scheduled_run' | 'webhook'
  thoughts       jsonb,                       -- array of {step, text, toolCalls, toolResults}
  final_response text,
  created_at     timestamptz default now()
);

create index idx_split_members_invoice   on split_members(paypal_invoice_id);
create index idx_splits_group_open       on splits(group_id) where status = 'open';
create index idx_user_memory_user_group  on user_memory(user_id, group_id);
create index idx_reasoning_log_group     on reasoning_log(group_id, created_at desc);
```

---

## The agent (`src/agent/run.ts`)

Vercel AI SDK does the loop. We just assemble tools, prompt, context.

```typescript
import { generateText, stepCountIs } from 'ai';
import { getModel } from '../llm/providers';
import { buildSystemPrompt } from './system-prompt';
import { getAllTools } from './tools';
import { persistReasoning } from './reasoning-log';

export async function runAgent(input: AgentInput): Promise<AgentOutput> {
  const result = await generateText({
    model: getModel(),                      // Groq primary, Gemini fallback
    system: buildSystemPrompt(input),
    prompt: input.userMessage,
    tools: await getAllTools(input.context),
    stopWhen: stepCountIs(6),
  });

  await persistReasoning(input, result.steps, result.text);
  return { response: result.text, steps: result.steps };
}
```

That's it. The SDK runs the loop, calls tools, feeds results back, decides when to stop. We get `result.steps` (array of thoughts + tool calls + tool results) for the reasoning log for free.

---

## Tool catalogue

### From `@paypal/agent-toolkit/ai-sdk` (pre-wired, we DON'T write these)
- `create_invoice`
- `send_invoice`
- `send_invoice_reminder`
- `cancel_sent_invoice`
- Deliberately NOT exposed to the agent: `list_invoices` (lists the whole merchant account across groups — in the milestone-5 live run the agent found and reminded another group's invoice on a guess), orders (invoices only; toolkit orders are USD-only), subscriptions, disputes.
- Every exposed invoice tool is wrapped by `src/agent/tools/paypal_scoped.ts` (the PayPal call is still the toolkit's): invoice ids must belong to this group's split members or be created in the same run; `send_invoice_reminder` shares telegram_dm's 1-per-user-per-24h limit; results are normalised to `{ ok, ... }`; `get_invoice` returns a compact summary (Groq free tier = 8k tokens/min).

Toolkit setup:
```typescript
import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk';

const paypalToolkit = new PayPalAgentToolkit({
  clientId: config.PAYPAL_CLIENT_ID,
  clientSecret: config.PAYPAL_CLIENT_SECRET,
  configuration: {
    actions: {
      invoices: { create: true, send: true, get: true, sendReminder: true, cancel: true },
    },
    context: { sandbox: true }
  }
});

export const paypalTools = paypalToolkit.getTools();
```

### Our custom tools (`src/agent/tools/`)
| Tool | When agent uses it | Writes to |
|------|--------------------|-----------|
| `fetch_group_history` | Needs context about past splits | — (read-only) |
| `get_member_profile` | Personalising a reminder | — (read-only) |
| `remember_preference` | User states a pref, or agent infers one | `user_memory` |
| `schedule_followup` | Wants to nag in N hours | sets `splits.next_nag_at` |
| `summarise_debt` | User asks net balances | — (read-only aggregate) |
| `telegram_dm` | Needs to DM a specific group member | Telegram API |

Final tool list fed to the agent = `{ ...paypalTools, ...customTools }`.

---

## System prompt (`src/agent/system-prompt.ts`)

```
You are Siren, an autonomous payment agent for Telegram groups.

You have access to PayPal tools (create/send/cancel invoices, remind, orders),
tools to look up group history and member payment profiles, tools to remember
preferences, and tools to schedule your own follow-ups and send Telegram DMs.

Core rules:
- Think step by step. Use tools to gather facts before answering.
- Never invent participants, amounts, or payment history.
- "me" / "us" always includes the sender.
- "the lads" / "the gang" refers to known group members — if unsure who, ask.
- Currency defaults to EUR unless the user used $, £, "dollars", "pounds".
  "quid" = EUR for Irish users (sender country: {{sender_country}}).
- Before nagging, always call get_member_profile first. Adapt your tone:
    chill   → "no rush, €6 outstanding for football when you get a sec"
    neutral → "friendly reminder: €6 still owed for football"
    direct  → "still waiting on €6 for football — pay here <link>"
- Rate limit: never nag the same user twice within 24h.
- You are being called from: {{trigger}} (user_message | scheduled_run | webhook).

Group context (injected per call):
- Members with their reliability scores + preferred tones
- Current open splits + unpaid members
- Last 3 reasoning_log entries for this group
```

---

## Autonomous scheduler (`src/scheduler/runner.ts`)

```typescript
import cron from 'node-cron';
import { runAgent } from '../agent/run';
import { db } from '../db/client';

cron.schedule('0 */6 * * *', async () => {
  const openSplits = await db.splits.findOpen();
  for (const split of openSplits) {
    const unpaid = await db.splitMembers.findUnpaid(split.id);
    if (unpaid.length === 0) continue;

    await runAgent({
      trigger: 'scheduled_run',
      userMessage: `[internal] Split "${split.description}" has ${unpaid.length} unpaid members. Decide what to do.`,
      context: { groupId: split.group_id, splitId: split.id }
    });
  }
});
```

Agent decides: nag, check-in, wait, or do nothing. Reasoning persisted regardless. **This is the autonomy claim.**

---

## Memory logic (unchanged from v2)

Reliability score:
```
reliability = (0.6 * on_time_ratio) + (0.4 * speed_score)
  on_time_ratio = paid_within_72h / total_splits
  speed_score   = clamp(1 - (avg_hours_to_pay / 168), 0, 1)
```

Auto preferred tone (overridable with `/siren tone`):
- `> 0.8` → chill
- `0.4–0.8` → neutral
- `< 0.4` → direct

Memory updates triggered by: webhook payment, scheduled runs decrementing on no-pay after N days, agent's `remember_preference` tool.

---

## Core flows (updated for Vercel AI SDK)

### Flow A — New split
```
Group msg → middleware → handlers/message.ts → runAgent({ trigger: 'user_message' })
Step 1  thought "User wants €60 split 10 ways for football"
        tool    create_invoice (×10, from PayPal toolkit)
        result  invoices sent, links returned
Step 2  tool    telegram_dm (×10, deliver links)
Step 3  tool    (implicit respond) "Sent 10 requests. /status anytime."
```

### Flow B — Payment received
```
PayPal webhook → verify sig → update split_members → trigger memory update
  → runAgent({ trigger: 'webhook', userMessage: '[internal] Jay paid €6 for football, 7h after request' })
    Step 1  tool  remember_preference({ user: jay, update: {...} })
    Step 2  tool  telegram group post "🎉 Jay paid €6 — 7/10 in"
```

### Flow C — Scheduled nag
```
Cron → for each open split → runAgent({ trigger: 'scheduled_run' })
  Step 1  tool  (query split_members) → unpaid: sean, mike, hours_elapsed: 48
  Step 2  tool  get_member_profile(sean) → {reliability 0.9, chill, avg 5h}
  Step 3  thought "Sean normally pays in 5h, now 48h — unusual, send check-in not nag"
          tool  telegram_dm(sean, "No rush, just checking in — football money still outstanding, hope all's well")
  Step 4  tool  get_member_profile(mike) → {reliability 0.3, direct, 2 reminders}
  Step 5  tool  telegram_dm(mike, "Third reminder — €6 still owed for football, pay here <link>")
```

### Flow D — `/siren about <name>`
```
Command → runAgent
  Step 1  tool  get_member_profile(jay)
  Step 2  tool  fetch_group_history({ user: jay, limit: 5 })
  Step 3  implicit respond "Jay — pays on avg within 6h, 94% reliable, prefers chill reminders.
          Last 5 splits all paid, median 5h. Current: €6 outstanding for football, sent 2h ago."
```

---

## PayPal webhooks (we own this, not toolkit)

Toolkit doesn't handle incoming webhooks — only outbound API calls. So:

- `src/paypal/webhooks.ts` → PayPal **self-verification** (CRC32 of raw body + SHA256withRSA against the cert at `paypal-cert-url`, `*.paypal.com` only). Chosen over the `verify-webhook-signature` postback: no extra API call, and it is the only method that works for Webhook Simulator events (signed with webhook id `WEBHOOK_ID`, accepted only when `PAYPAL_WEBHOOK_ALLOW_SIMULATOR=true`).
- `src/routes/paypal.ts` → `POST /webhook/paypal`, verify → dispatch `INVOICING.INVOICE.PAID` / `INVOICING.INVOICE.CANCELLED` (idempotent: repeat deliveries change 0 rows)

Webhook subscription setup (manual, after Render deploys):
1. Dev dashboard → Sandbox App → Add Webhook
2. URL: `https://<render-url>/webhook/paypal`
3. Events: `Invoicing invoice paid` (`INVOICING.INVOICE.PAID`), `Invoicing invoice cancelled` (`INVOICING.INVOICE.CANCELLED`)
4. Copy `webhook_id` → `.env` `PAYPAL_WEBHOOK_ID`

---

## Build order (29 days, rebalanced with 2 days freed by toolkit)

| Days | Milestone |
|------|-----------|
| 1–2  | Scaffold Fastify + grammy + env config + Supabase schema applied + CLAUDE.md checked in |
| 3    | PayPal Agent Toolkit init + sanity test (create test invoice from a script) |
| 4    | PayPal webhook route + sig verify + sandbox simulator test |
| 5–6  | Vercel AI SDK agent setup — `runAgent` + Groq provider + system prompt + ONE custom tool (`telegram_dm`) |
| 7    | Telegram handlers wire message → runAgent → reply + inline confirmation card for new splits |
| 8–9  | Remaining 5 custom tools: `fetch_group_history`, `get_member_profile`, `remember_preference`, `schedule_followup`, `summarise_debt` |
| 10   | Memory logic — reliability score + tone picker + webhook → memory update |
| 11   | Scheduler + autonomous nag flow |
| 12   | Gemini fallback wiring + prompt cache |
| 13   | Render deploy + UptimeRobot + full end-to-end on live URL |
| 14   | Error handling, logging, retry policies, rate-limit enforcement in tools |
| 15–16| Optional dashboard (open splits + reliability + reasoning log viewer) |
| 17–20| Polish, README, demo video script, agent-reasoning on-screen for demo |
| 21–22| Record demo (3 takes, show agent reasoning in group), cut to <3 min, upload YouTube |
| 23   | Submit on Devpost |
| 24–29| Buffer / stretch (receipt-vision, A2A cross-group settlement if everything green) |

Build-order rule: **tests pass at each milestone** before moving on.

---

## Known risks + mitigations (updated)

| Risk | Mitigation |
|------|------------|
| PayPal toolkit API changes mid-build | Pin exact version in package.json; subscribe to repo releases |
| Agent calls PayPal tools incorrectly | Toolkit's own schemas constrain this; add zod validation on our custom tools |
| Agent loops forever | `stopWhen: stepCountIs(6)` enforced by Vercel AI SDK — can't exceed |
| Agent spams group | Nag rate-limit (1/24h/user) enforced inside `telegram_dm` tool handler before send |
| PayPal sandbox outage during demo | Pre-recorded backup clip on a known-good day |
| Render cold start | UptimeRobot ping every 10 min |
| Groq 1000 RPD limit | 1h prompt cache + Gemini fallback |
| Webhook sig mismatch | Log full headers on fail; test via PayPal Simulator before live sandbox events |
| Memory writes stale | Agent `remember_preference` validated via zod; `preferred_tone` constrained to enum |
| Vercel AI SDK telemetry leaking data | Telemetry not enabled (no exporter); steps are persisted to `reasoning_log` ourselves, tool outputs clipped to 2,000 chars |

---

## README template (for build-AI to write)

Sections, in order:
1. One-paragraph pitch (reframed agent pitch from SCOPE.md)
2. Demo GIF (placeholder — Damian records)
3. **"Built on PayPal Agent Toolkit"** banner — one line + link to `paypal/agent-toolkit`
4. Agent architecture diagram (mermaid)
5. Tool catalogue:
   - PayPal tools (from toolkit) — bulleted + link to toolkit docs
   - Custom tools — bulleted + one-line description each
6. PayPal APIs used (via toolkit): Invoicing + Orders
7. AI stack: Vercel AI SDK + Groq primary + Gemini fallback + agent loop description
8. **Setup for judges**: commands, env vars, Telegram link to invite the bot, 3 sandbox accounts to test with
9. Local development (clone → install → env → `npm run db:push` → `npm run dev`)
10. Project structure (tree)
11. Deployment (Render blueprint explained)
12. Hackathon track eligibility: Agentic Commerce + Best Use of PayPal + AI
13. License (MIT)

---

## Reference implementations (lift freely)

| Repo / doc | What to lift |
|------------|-------------|
| [paypal/agent-toolkit](https://github.com/paypal/agent-toolkit) | Toolkit setup, examples under `/typescript/examples` |
| [Vercel AI SDK docs](https://sdk.vercel.ai) | `generateText({ tools, stopWhen })` pattern, Groq provider setup |
| [paypaldev/getting-started-with-paypal-sandbox](https://github.com/paypaldev/getting-started-with-paypal-sandbox) | Sandbox account setup, test flows |
| [grammy docs](https://grammy.dev) | Telegram bot setup, group handling, inline buttons |
| [Supabase JS docs](https://supabase.com/docs/reference/javascript) | Client init, query patterns |

---

## v2+ stretch (only if days 24–29 green)

- **Receipt vision**: upload photo → Gemini Vision parses line items → agent asks "who had the carbonara?" → fair split. Adds `parse_receipt` tool.
- **A2A cross-group settlement**: group A owes group B across multiple splits. Both Siren agents negotiate net settlement, one PayPal transfer instead of twenty. Strongest Agentic Commerce prize bait but genuinely hard.

---

## Decisions (answered before milestone 1)

1. **Bot handle**: the `@siren_*` handle registered on BotFather (token in `TELEGRAM_BOT_TOKEN`; not hard-coded anywhere).
2. **PayPal pay-to account**: sandbox Business account auto-created with the app — confirmed.
3. **Dashboard**: build it only if milestones 1–14 ship on time. Plain HTML + fetch first; AG Grid at the dashboard milestone if time allows (sponsor prize eligibility).
4. **License**: MIT.
5. **Bot voice**: light Irish ("the lads", "sound", "deadly") in reminder tones only. Neutral English for commands + status.
6. **Money flow**: A — payers are invoiced to the group creator's sandbox Business account. No Payouts API.
7. **Receipt-vision**: README roadmap mention only. Not built in v1.
