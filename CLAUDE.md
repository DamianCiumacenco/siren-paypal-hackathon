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

## Milestone checklist (before every milestone commit)
1. `npm run typecheck && npm test`: unit/route tests (app built with `app.inject()`, no network).
2. `npm run test:startup`: boots the REAL server for 15s with `.env.local` and asserts it stays up, `/health` answers, and SIGTERM exits cleanly. `inject()` tests can't catch startup crashes (milestone 4: a grammy webhook/polling clash killed the server ~10s after boot). Stop `npm run dev` first; a second poller gets a Telegram 409.
3. Live check against sandbox where the milestone touches PayPal (e.g. `npm run paypal:sanity`, or the runbook below).

## Runbook: live PayPal webhook test (tunnel + Webhooks Simulator)
Use whenever a milestone changes `/webhook/paypal` handling. Do all the setup BEFORE asking the human to click, and give them everything in one message.
1. `brew install cloudflared` (once).
2. Start the server with simulator events allowed, for this run only (never put it in `.env.local` or Render):
   `PAYPAL_WEBHOOK_ALLOW_SIMULATOR=true npx tsx src/server.ts > <scratchpad>/server.log 2>&1 &`
3. Wait ~20s and confirm the log shows `Telegram long polling as @…` and the process is still alive (or just run `npm run test:startup` first).
4. `cloudflared tunnel --no-autoupdate --url http://localhost:3000 > <scratchpad>/tunnel.log 2>&1 &`, take the `https://*.trycloudflare.com` URL from the log and `curl <url>/health`.
5. Start a Monitor on server.log that filters for `PayPal webhook` plus warn/error levels (`"level":(40|50|60)`), so rejections and crashes show up too.
6. Send the human ONE message: developer.paypal.com → Testing Tools → Webhooks Simulator → URL `<tunnel>/webhook/paypal` → events "Invoicing invoice paid" + "Invoicing invoice cancelled" → Send.
7. Pass = each event logs `PayPal webhook processed` with `simulator: true` and a 200 response. `updated: 0` is expected (mock invoice ids aren't in our DB). Any `PayPal webhook rejected` means check the logged `reason`.
8. If the tunnel log shows `connection refused`, the server died: check server.log before asking the human to resend.
9. Tear down: stop the Monitor, kill the server + cloudflared, confirm with `pgrep`. Put the event ids + results in the milestone commit message.

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
