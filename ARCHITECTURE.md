# Siren — Architecture & Build Plan (v3)

Target audience: Claude Code (or any build-AI). Everything needed to generate the full codebase lives here. Reframed around the official **PayPal Agent Toolkit** + **Vercel AI SDK** — not hand-rolled.

---

## Stack (locked)

- **Runtime**: Node.js 22 LTS + TypeScript (strict)
- **Framework**: Fastify 5
- **Telegram**: `grammy`
- **Agent engine**: Vercel AI SDK (`ai` npm pkg) — provides `generateText({ tools, stopWhen })` which IS the agent loop; no hand-rolled loop needed
- **PayPal tools**: `@paypal/agent-toolkit/ai-sdk` — official toolkit, pre-wired PayPal tools for function-calling (invoicing, orders, subscriptions, disputes, shipment tracking)
- **LLM providers** (failover chain, `src/llm/`, pulled forward from milestone 12): `@ai-sdk/groq` primary (`openai/gpt-oss-120b`) → `@ai-sdk/google` (`gemini-3.5-flash`; 2.5-flash is closed to new users) → NVIDIA NIM via `@ai-sdk/openai` `.chat()` on `https://integrate.api.nvidia.com/v1` (`nvidia/nemotron-3-ultra-550b-a55b`; nemotron-3-super-120b is "not found for account" on the free dev key). Models configurable via `GEMINI_MODEL` / `NVIDIA_MODEL`.
  - Per-minute limits → wait for retry-after (≤60s). Daily quota → bench that provider ≥1h and fail over (logged). 5xx (e.g. Gemini 503 "high demand") → next provider for that call. All out → honest "AI quota is used up" reply.
  - DMs: telegram_dm replaces any amount the model wrote with the real share and appends the real pay link (models were seen writing "€5" for a €10 share, or omitting the link).
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
│   │   ├── commands.ts              # /start /split /status /nag /help /siren ...  (/status + /siren why: handlers/status.ts, handlers/why.ts — no LLM)
│   │   ├── middleware.ts            # group auto-register, user resolve
│   │   └── handlers/
│   │       ├── message.ts           # free-text → agent
│   │       └── callback.ts          # inline-button taps (confirm/cancel split)
│   ├── llm/
│   │   ├── providers.ts             # Groq primary, Gemini fallback — model factory
│   │   ├── failover.ts              # Groq → Gemini → NVIDIA chain
│   │   └── rate-limit.ts            # per-provider 429 handling (no response cache — see milestone 12)
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
- `create_invoice` / `send_invoice` are called from code (`src/paypal/split_invoices.ts`) after the ✅ tap, not by the LLM (milestone 7: their schemas cost ~2,900 tokens/step). The agent sees `get_invoice`, `send_invoice_reminder`, `cancel_sent_invoice` + custom tools.
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
| `send_split_invoices` | New split (user_message only). Slim schema (~300 tokens) instead of the toolkit's create_invoice (~2,700). Saves a **draft**; invoices go out only after the creator taps ✅ | `splits` (status `draft`), `split_members` |
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

## Autonomous scheduler (`src/scheduler/runner.ts`, milestone 11)

`NAG_CRON_INTERVAL` (default `0 */6 * * *`; `*/5 * * * *` for a live demo), node-cron with `noOverlap`.
Each pass, per open split (oldest first):
1. Recompute memory for unpaid linked members (deterministic: overdue shares lower reliability).
2. Skip WITHOUT an LLM call if: the agent scheduled a later follow-up (`next_nag_at`), every unpaid member was reminded <24h ago, or the group is busy (shared `ChatLock` with user messages).
3. Otherwise `runAgent({ trigger: 'scheduled_run', … split_id … })`. Agent decides: remind in tone, check in, wait (`schedule_followup`), or nothing. No sender → no `send_split_invoices`.
4. Post the (sanitised) summary to the group only if it actually reminded someone; quiet decisions live in `reasoning_log` (`/siren why` → "scheduled check").
5. All LLM providers out of quota → stop the pass, log, no group message. Other errors → log (safe), continue with the next split.

The 24h cap, group isolation and paid-member protection are enforced in the tools, so they hold identically for scheduled runs. Members without Telegram are rate-limited by their own `last_reminded_at` (PayPal reminder emails).

## Memory logic (unchanged from v2)

Reliability score:
```
reliability = (0.6 * on_time_ratio) + (0.4 * speed_score)
  on_time_ratio = paid_within_72h / total_splits
  speed_score   = clamp(1 - (avg_hours_to_pay / 168), 0, 1)
```

Which shares count: resolved ones only — paid, or unpaid past the 72h window (late). Shares still inside their window don't count yet; cancelled never. No resolved shares → reliability null (not 0). Implemented in `src/memory/scoring.ts`, always recomputed from scratch (idempotent).

Auto preferred tone (overridable with `/siren tone`; an explicitly set tone sets `user_memory.tone_locked` and is never auto-overwritten):
- `> 0.8` → chill
- `0.4–0.8` → neutral
- `< 0.4` → direct

Memory updates triggered by: webhook payment, scheduled runs decrementing on no-pay after N days, agent's `remember_preference` tool.

---

## Core flows (updated for Vercel AI SDK)

### Flow A — New split (milestone 7)
```
Group msg (/split, @mention or reply to Siren — other chatter never reaches the agent)
  → middleware (register group/user/membership) → handlers/message.ts (1 run per group at a time, in background)
  → runAgent({ trigger: 'user_message' })
Step 1  tool    send_split_invoices({ description, total, currency, participants }) → draft split
Step 2  reply   "Drafted €18 football, €6 each — tap ✅ on the card"
Bot     card    "New split: 6.00 EUR each, 3 people … [✅ Send requests] [❌ Cancel]"  (text from the tool result, not the LLM)
✅ tap (creator only, atomic draft→open, so double taps are no-ops) — NO LLM in the money path:
        per member: toolkit create_invoice → send_invoice(send_to_recipient:false) → payer link
        → store invoice id + link → DM link (403 / unknown member → link posted in group)
        → group summary
```

### Flow B — Payment received (milestone 10: deterministic, no LLM)
```
PayPal webhook → verify sig → mark split_member paid (idempotent)
  → only on the delivery that changed the row (routes/paypal.ts onInvoicePaid):
    recomputeMemory(user, group)   full recompute from payment record (memory/scoring.ts), auto tone unless tone_locked
    settle split if nobody still owes
    group post "✅ Jay paid 6.00 EUR for "football" — 7/10 paid." (+ "🎉 … settled")
```
Hook failures are logged (safe) and answered 200: a PayPal retry updates 0 rows and skips the hook; recompute is idempotent so the scheduler can heal memory later.

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

### Flow E — `/siren why` (milestone 10: no LLM)
```
Command → latest reasoning_log row for the group → formatWhy(): Step N: thought → tool call (safe args) → result
Redacted for the group: links, invoice numbers, uuids/ids removed; DM and note text never shown.
```

### Flow F — `/status` (milestone 13: no LLM)
```
Command → this group's splits (history store) → formatStatus(): open splits, or "No open splits" + the most recent one
Per member row: paid ✅ / owes €X / cancelled. The creator gets one line: "paid the bill (own share, nothing owed)".
```
**Why it's code, not the agent:** in the live e2e on Render the agent read "€2 total, €1 each" and told the group the creator "still owes €1". Same bug class as the invented "€5" in milestone 7. Rule everywhere: **the creator paid the bill; their own share is never a debt — only `split_members` rows can owe.** Enforced in `/status` (code), `summarise_debt` (skips creator → creator), the agent's `<context>` ("bill paid by X (owes nothing …)"), `fetch_group_history` (`bill_payer_owes: 'nothing'`) and a system-prompt rule. Free-text "who still owes?" still goes to the agent; `agent:live --scenario memory` asserts it never says the creator owes.

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
| 12   | ~~Gemini fallback wiring~~ (done early: Groq → Gemini → NVIDIA chain) + provider-side prompt caching layout (see "Milestone 12" below) |
| 13   | Render deploy + UptimeRobot + full end-to-end on live URL |
| 14   | Error handling, logging, retry policies, rate-limit enforcement in tools |
| 15–16| Optional dashboard (open splits + reliability + reasoning log viewer) |
| 17–20| Polish, README, demo video script, agent-reasoning on-screen for demo |
| 21–22| Record demo (3 takes, show agent reasoning in group), cut to <3 min, upload YouTube |
| 23   | Submit on Devpost |
| 24–29| Buffer / stretch (receipt-vision, A2A cross-group settlement if everything green) |

Build-order rule: **tests pass at each milestone** before moving on.

---

## Milestone 12 — prompt caching (revised scope)

**Original plan, scrapped:** "1h cache on identical prompts" (`llm/cache.ts`).
**Why it was wrong for an agent:** a cached *response* replays a past decision without running its tools. A cache hit on "remind Jay" would post "Reminded Jay." while no DM goes out, and the reasoning log would record actions that never happened. Every agent prompt also carries the current time and live group state, so "identical prompts" would almost never occur, and when they did, replaying them would be wrong. **Lesson: cache what's stable (the prompt prefix), never an agent's decisions.**

**What shipped instead: provider-side prompt caching layout.** Providers cache a long *identical prefix*; decisions are still computed fresh every call.
- `system` = `STABLE_SYSTEM_PROMPT`: byte-identical on every call (no time, trigger, sender or ids).
- Tools: the same set in the same order on every trigger (`send_split_invoices` is always offered and refuses without a sender).
- User turn = `<context>` block (trigger, sender, country, time, group snapshot) + the message. Everything per-call lives here, after the prefix.
- Telemetry: every step records `tokens.cached` (`usage.inputTokenDetails.cacheReadTokens`; undefined = provider didn't report it). Shown per step in `/siren why` ("3.1k in, 2.0k cached"), logged per run as `agent run finished {inputTokens, cachedTokens, cacheHitPct, models}`, and measured by `npm run agent:live -- --scenario cache`.

**Measured (2026-10-22, free tiers):** 0 cached tokens on all three providers. Groq `gpt-oss-120b` returns no `prompt_tokens_details` at all (and requests are served from several regions: fra, lhr); Gemini `gemini-3.5-flash` and NVIDIA `nemotron-3-ultra` report `cached 0` even for an identical 5k-token prefix. So the expected 50–70% saving isn't available on these tiers. The layout is in place and the telemetry will show hits the day a provider caches.

**Re-measured at milestone 13 (2026-10-23, still free tiers; Groq Dev tier skipped by decision):**
- Production (Render, Frankfurt), `npm run cache:report -- 48`: 4 agent runs, 5 Groq steps, 13.8k input tokens, cached **not reported** on every step. Real traffic is sparse (minutes to hours between calls), so a provider prefix cache, which lives minutes, rarely gets a second hit.
- Local `agent:live --scenario memory`: Groq `gpt-oss-120b` reported its **first hit: 2,304 of 2,997 input tokens cached (77%)** on a call made right after another one with the same prefix. So Groq's free tier does cache, but only for back-to-back calls and without reporting it otherwise. Over a whole run: 10% (memory scenario), **35% for the full `agent:live`** (20 steps, 22.3k of 63.6k input tokens cached) and 42% for the scheduler scenario, where passes hit several splits in a row.
- Conclusion: the prefix layout works when calls come in quick succession (a busy group, a scheduler pass over several splits). It's not a cost lever at hackathon traffic, and no change is planned.

## Known risks + mitigations (updated)

| Risk | Mitigation |
|------|------------|
| PayPal toolkit API changes mid-build | Pin exact version in package.json; subscribe to repo releases |
| Agent calls PayPal tools incorrectly | Toolkit's own schemas constrain this; add zod validation on our custom tools |
| Agent loops forever | `stopWhen: stepCountIs(6)` enforced by Vercel AI SDK — can't exceed |
| Agent spams group | Nag rate-limit (1/24h/user) enforced inside `telegram_dm` tool handler before send |
| PayPal sandbox outage during demo | Pre-recorded backup clip on a known-good day |
| Render cold start | UptimeRobot ping every 10 min |
| Groq free-tier limits (8k tokens/min, 200k/day) | Skip-without-LLM fast paths, LLM-free money paths, Groq → Gemini → NVIDIA failover. (A response cache was rejected — see Milestone 12.) |
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
