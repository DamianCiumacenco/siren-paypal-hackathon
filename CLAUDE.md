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
3. `npm run test:pii`: log output must contain no member names, amounts or message text (hard rule below).
4. Live check against sandbox where the milestone touches PayPal or the agent (`npm run paypal:sanity`, `npm run agent:live`, or the webhook runbook below). `agent:live` seeds a throwaway group + real sandbox invoice, runs the real agent, checks guardrails, and cleans up (cancels the invoice). Groq free tier: 8k tokens/MINUTE (wait ~60s between agent runs) and 200k tokens/DAY, rolling 24h. A full `agent:live` costs ~90k tokens (it fails over to Gemini/NVIDIA if Groq runs out), so run single scenarios (`--scenario …`) unless a full pass is needed. `--only groq|gemini|nvidia` proves one provider; `--switch-after N` simulates Groq's daily cap mid-run. The payment scenario uses no LLM.

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

## Runbook: production (Render free tier)
- Deploy = push to `main` (Render auto-deploys from `render.yaml`). Free instance sleeps after 15 min idle; UptimeRobot pings `/health` every 5 min so the bot and scheduler stay up.
- Env vars live in the Render dashboard (never in the repo). `PUBLIC_URL` = the service's own `https://….onrender.com` (Telegram webhook mode). Never set `PAYPAL_WEBHOOK_ALLOW_SIMULATOR` on Render.
- After a deploy: `npm run verify:live -- <url>` (health, Telegram webhook target + errors, webhook auth). `npm run cache:report -- 24` = prompt-cache stats from what production recorded.
- **Local runs while production is live are PASSIVE:** if Telegram's webhook is set, a local `npm run dev` / `test:startup` doesn't poll, doesn't delete the webhook and doesn't start the scheduler (it shares the prod database). To test locally on Telegram on purpose: `TELEGRAM_FORCE_POLLING=true`; production re-registers its webhook on its next restart/deploy (or redeploy from the Render dashboard).
- Logs: Render dashboard → Logs. Same safe-logging rules (ids only).
- **E2E suite (`npm run test:e2e`, milestone 14):** the 7 SCOPE success criteria against the LIVE URL (`E2E_BASE_URL`, default `https://siren-5brb.onrender.com`), one file per criterion (`test/e2e/criterion-N-*.test.ts`), with a PASS/FAIL line per criterion at the end. Needs `E2E_SECRET` with the same value in `.env.local` and on Render. Only Telegram is mocked: production's sink (`src/e2e/sink.ts`) captures messages to the throwaway chats the suite registers. PayPal, LLM, webhook signatures and the DB are real; payments use the toolkit's `record_payment_for_invoice`, which makes PayPal send the real signed `INVOICING.INVOICE.PAID`. ~5 min, ~5 agent runs. Seed memory through real history (settled past splits), never hand-set scores: every scheduler pass recomputes them.
- **Before demo day: remove `E2E_SECRET` from Render** (Environment → delete → Save, rebuild, and deploy), then `curl -s -o /dev/null -w '%{http_code}' <url>/e2e/outbox?chat=1` must print **404** (routes gone), not 401. It's left on until then so `npm run test:e2e` keeps working; re-add the `.env.local` value to run the suite again later.

## Runbook: manual E2E test in a real Telegram group (human + mates)
For Damian + 3 mates ("Jay", "Sean", "Mike"). Uses the sandbox, so no real money moves. ~20 min. Send the mates `TESTING.md` beforehand: it covers their steps (Start the bot, say hi in the group, sandbox login).

**Before (Damian, laptop)**
1. `npm run db:reset -- --yes` cancels open sandbox invoices and wipes all Siren data. Then `npm run db:check`.
2. Make sure nothing else is polling the bot: stop any other `npm run dev` and don't deploy to Render mid-test. Two pollers get a Telegram 409 and one crashes.
3. Set `NAG_CRON_INTERVAL=*/5 * * * *` in `.env.local` so the autonomous nag shows up within minutes (remove it after the test). Then `npm run test:startup`, then `npm run dev` and leave it running. Wait for `Telegram long polling as @siren_pay_bot`.
4. Optional (needed for "paid" to update): run a cloudflared quick tunnel to `localhost:3000`. In the PayPal dashboard → Siren Dev app → Webhooks, add `<tunnel>/webhook/paypal` with "Invoicing invoice paid" + "Invoicing invoice cancelled". Put its id in `PAYPAL_WEBHOOK_ID` and restart `npm run dev`. The quick-tunnel URL changes every run, so update the webhook each session. Keep `PAYPAL_WEBHOOK_ALLOW_SIMULATOR` unset.

**Setup in Telegram (order matters)**
5. Create a group and add `@siren_pay_bot`. If the bot was added before `/setprivacy → Disable`, remove and re-add it, or it won't see group messages.
6. EACH mate (any order, but ALL before the first /split):
   a. Opens a private chat with `@siren_pay_bot` and presses **Start**. Until they do, Siren can't DM them, and their pay link gets posted in the group instead.
   b. Sends any message in the group ("hi"). This registers them as a group member so `/split` can match their name. Two people with the same first name → use `@username` in `/split`.
7. Give each mate a sandbox Personal login (SETUP.md §1.5). Pay links only work when logged into a **sandbox** account, never a real one.

**Test script (in the group)**
8. Damian: `/split €24 pizza with Jay, Sean and Mike` → reply + card. Jay taps ✅: refused (creator only). Damian taps ✅: each mate gets a DM with their pay link, plus a group summary.
9. `/status`, `@siren_pay_bot who still owes?`, `/siren debt`.
10. Jay pays his link (sandbox login). With the webhook from step 4, the group gets "✅ Jay paid … — 1/3 paid" (no LLM) and his memory is recomputed. The last payment settles the split with 🎉.
11. Autonomy: leave a split unpaid. Within ~5 min the scheduler reminds overdue members on its own (posts "Reminded …"); `/siren why` then says "scheduled check". `/siren why` (shows the last decision's real steps, redacted), `/siren tone chill` (Sean), `/siren about Mike`, `/nag` → reminders respect each person's tone, max 1 per person per 24h (a second `/nag` is refused).
12. `/split €10 test with Jay` → ❌ Cancel → nothing is sent.

**LLM budget:** Groq free tier = 200k tokens/day (rolling), ~25 agent replies. When it runs out, Siren fails over to Gemini, then NVIDIA NIM (logged as `LLM provider quota exhausted — failing over`). Only if all three are out does it reply "AI quota is used up on every provider". Deterministic paths (✅ send, payment posts, `/siren why`) use no LLM.

**Watch for** (terminal running `npm run dev`): errors show ids only, never names or message text. Anything else is a `test:pii` bug, so note the update id. Groq free tier = 8k tokens/min: if Siren says it's over its rate limit, wait a minute.

**Teardown**
13. Ctrl+C `npm run dev` (and the tunnel). Delete the tunnel webhook in the PayPal dashboard.
14. `npm run db:reset -- --yes` (cancels unpaid sandbox invoices, wipes data). Optionally remove the bot from the group.

## Guardrails
- Scope deltas: ask first.
- Secrets: never commit `.env.local`. `.env.example` with blank values only.
- Logging: never log full webhook payloads or PayPal tokens.
- **Errors reach logs ONLY via `logError` / `safeErrorMessage` (`src/lib/safe-error.ts`).** Never `console.error(err)`, `log.error({ err })` or `log.error(err)`: ai-sdk errors carry `requestBodyValues` (the whole prompt: names, amounts, messages) and grammy errors carry DM payloads. Log ids only (chat/update/split/member ids). The bot's first middleware is an error boundary so nothing throws up into Fastify's raw error logger in webhook mode. Covered by `npm run test:pii`.
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
