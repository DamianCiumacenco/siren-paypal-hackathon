# Siren — Scope (LOCKED v3)

**One-liner**: An autonomous payment agent on Telegram. Siren plans multi-step payment workflows, remembers each group member's payment behaviour, decides on its own when and how to follow up, and uses PayPal to execute.

**Pitch for LinkedIn / GitHub / Devpost**:
> Autonomous Telegram payment agent built on the official **PayPal Agent Toolkit** + **Vercel AI SDK**, Groq-powered with Gemini fallback, Supabase memory, and a scheduled runner that lets the agent decide for itself when to follow up. Submitted to the PayPal AI Hackathon 2026 under Agentic Commerce + Best Use of PayPal + AI.

---

## In scope (ship this)

### Core payment loop
- Telegram bot (group chats + DMs) via `grammy`
- Agent loop via Vercel AI SDK `generateText({ tools, stopWhen: stepCountIs(6) })`
- PayPal tools pulled from `@paypal/agent-toolkit/ai-sdk` (invoicing, orders, subscriptions, disputes)
- Deliver each person's pay link via Telegram DM
- Webhook listener → mark paid → update group

### Memory + learning
- Per-user profile: avg payment speed, reliability score, preferred reminder tone, past splits
- Agent reads memory before every action; nag tone adapts
- `/siren about <name>` → show what Siren learned about that person

### Autonomy + transparency
- Scheduled runner (every 6h): check open splits, agent decides whether/who/how to nag
- Reasoning log persisted and surfaced via `/siren why` + optional dashboard
- Rate limits respected by the agent itself (max 1 reminder/user/24h)

### Commands
- `/start`, `/split`, `/status`, `/nag`, `/help`
- `/siren about <name>` — memory lookup
- `/siren why` — last reasoning log
- `/siren debt` — net balance across all group splits
- `/siren tone <chill|neutral|direct>` — manual tone override

### Dashboard (optional stretch, days 15–16)
- Read-only web page: open splits, member reliability scores, agent reasoning log viewer
- Served from the same Fastify instance

## Out of scope (do NOT build)
- Savings goals / auto-deduct
- Budget analysis
- Receipt photo OCR (stretch only — days 24–29 if everything else bulletproof)
- WhatsApp / SMS / Discord
- Native iOS/Android
- Real-money production (sandbox only)
- Cross-group memory bleed (per-group isolation)
- Agent-to-agent cross-group settlement (stretch only)

## Success criteria (demo must show all 7)

1. Natural-language group message parsed correctly
2. Each named person gets a working PayPal payment link in DM
3. Sandbox payment → webhook fires → group status updates
4. `/status` shows who paid / who hasn't
5. Agent autonomously decides to nag + reasoning visible via `/siren why`
6. `/siren about <name>` returns a real learned profile (not a template)
7. At least 2 different reminder tones generated for 2 different user profiles — proves memory is used, not decorative

## Hard limits
- Max 20 participants per split
- EUR / USD / GBP only
- Sandbox only
- Groq free tier (1,000 req/day) — 1h prompt cache + Gemini fallback keeps us well under
