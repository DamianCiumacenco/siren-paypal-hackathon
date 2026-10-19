# Siren — Context for Claude Code

Project: autonomous PayPal payment agent on Telegram. PayPal AI Hackathon 2026 submission.

## Read these before any work (in order)
1. **SCOPE.md** — what's in / out / success criteria. Scope is LOCKED v3.
2. **SETUP.md** — all manual setup done by the human; env vars live in `.env.local`.
3. **ARCHITECTURE.md** — full build spec: stack, file structure, data model, agent, tools, flows, build order.

## Core stack (do not swap without asking)
- Node 22 LTS + TypeScript (strict)
- Fastify 5 + grammy (Telegram)
- **Vercel AI SDK** (`ai` npm) — `generateText({ tools, stopWhen: stepCountIs(6) })` IS the agent loop
- **@paypal/agent-toolkit/ai-sdk** — official toolkit, provides pre-wired PayPal tools
- `@ai-sdk/groq` primary, `@ai-sdk/google` fallback
- Supabase (hosted Postgres)
- node-cron for the autonomous runner
- zod everywhere

## Working rules
- Follow the build order in ARCHITECTURE.md milestone by milestone.
- **Stop after each milestone** for human review before proceeding.
- Tests must pass at each milestone.
- When uncertain about scope, ASK — do not expand.
- Keep `stopWhen: stepCountIs(6)` cap on the agent loop.
- Never hand-roll PayPal API calls — use the toolkit. The only exception is incoming webhook signature verification (toolkit doesn't do that).
- All env vars are set in `.env.local` (incl. `SUPABASE_DB_URL`, used only by `npm run db:push`) — do not re-ask the human. Never print or log their values.
- Commit at the end of every milestone with a clear message: `milestone N: <summary>`.

## Guardrails
- Scope deltas: ask first.
- Secrets: never commit `.env.local`. `.env.example` with blank values only.
- Logging: never log full webhook payloads or PayPal tokens.
- Rate limits: enforce in tool handlers, not just as prompt rules.

## Hackathon context
- Deadline: **Nov 12, 2026, 12:00 PM PST**
- Submission tracks targeted: **Agentic Commerce** + **Best Use of PayPal + AI**
- Judge criteria (equal weight): Tech Impl, Design, Impact, Innovation, Presentation
- README must call out "Built on PayPal Agent Toolkit" explicitly.

## When something breaks
Human (Damian) is a 2nd-year SWE student, limited time, reviewing not writing. Prefer:
- Clear error messages pointing at root cause
- Minimum-viable fixes over refactors
- Comments explaining non-obvious bits of PayPal/Telegram wire format
