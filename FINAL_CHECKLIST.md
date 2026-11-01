# Final checklist (before demo day and submission)

Tick each line in order. Production URL: `https://siren-5brb.onrender.com`. Deadline: **Nov 12, 2026, 12:00 PM PST**.

## 1. Last test run (while `E2E_SECRET` is still on Render)
- [ ] `npm run typecheck && npm test`: all green.
- [ ] `npm run test:e2e`: **7/7 criteria PASS** plus the dashboard extra (~5 min, ~5 agent runs, so not right after a heavy LLM session).
- [ ] Optional: the mates test in a real group (CLAUDE.md, "manual E2E test"), if anything changed since the last one.

## 2. Strip the test hooks
- [ ] Render → siren → Environment → delete `E2E_SECRET` → Save, rebuild, and deploy.
- [ ] `curl -s -o /dev/null -w '%{http_code}\n' https://siren-5brb.onrender.com/e2e/outbox?chat=1` prints **404** (routes gone), not 401.
- [ ] `PAYPAL_WEBHOOK_ALLOW_SIMULATOR` is **not** set on Render.
- [ ] `NAG_CRON_INTERVAL` on Render is what you want for the day: `0 */6 * * *` normally, `*/5 * * * *` only while recording the autonomous-nag scene (then put it back).

## 3. Production is alive
- [ ] `npm run verify:live -- https://siren-5brb.onrender.com` shows 9 ✓ lines and **LIVE CHECKS PASSED**: health, DB, Telegram webhook mode, dashboard page, dashboard API 401, Telegram webhook target + no delivery errors, webhook auth, PayPal webhook signature check.
- [ ] UptimeRobot: the `/health` monitor is **Up**, checks every 5 min, no downtime in the last 24h.
- [ ] Bot alive: `/help` in a group gets an instant reply; `/status` answers (no LLM).
- [ ] An agent reply works: `@siren_pay_bot who still owes?` answers within ~10s (proves the LLM chain is up). If it says the quota is used up, wait or record later; Groq's daily quota is a rolling 24h.

## 4. PayPal sandbox
- [ ] developer.paypal.com → Siren Dev app → Webhooks: the Render URL `…/webhook/paypal` is subscribed to **Invoicing invoice paid** + **Invoicing invoice cancelled**, and its id matches `PAYPAL_WEBHOOK_ID` on Render. Delete any leftover trycloudflare tunnel webhooks.
- [ ] Sandbox buyer accounts `jay@`, `sean@`, `mike@sandbox.test` each log in at sandbox.paypal.com and have a balance (developer.paypal.com → Sandbox → Accounts → the account's details).
- [ ] The app's **Invoicing** feature is still ticked.
- [ ] One real round trip: a €1 split → ✅ → pay the link → "✅ … paid" in the group within ~1 min.

## 5. Dashboard
- [ ] `/siren dashboard` in the demo group → DM with a link → page loads with members, splits and agent decisions.
- [ ] Clicking a decision row opens its steps; checked once on a phone too.

## 6. Demo group ready
- [ ] Demo group has the bot (privacy mode off) and every on-screen member has pressed Start and said "hi".
- [ ] Old test noise cleaned up if you want a clean screen (`npm run db:reset -- --yes` wipes ALL Siren data and cancels open sandbox invoices: only before seeding the demo group, never after).
- [ ] Seeded history for the two-tones scene (one fast payer, one slow payer), so `/siren about` and the reminders show learned profiles. See DEMO_RUNBOOK.md.

## 7. Submission
- [ ] Demo video (< 3 min) uploaded to YouTube (unlisted or public), link in the README and Devpost. Backup copy saved locally and in Google Drive.
- [ ] README: demo link/GIF in place, "Built on PayPal Agent Toolkit" banner present, judge setup current.
- [ ] Judges' sandbox passwords are in the Devpost testing notes (never in the repo).
- [ ] Devpost draft: both tracks ticked (**Agentic Commerce** + **Best Use of PayPal + AI**), repo link public, video link, screenshots (group chat, `/siren why`, dashboard), built-with list.
- [ ] Repo: `git status` clean, `.env.local` not committed (`git ls-files | grep env` shows only `.env.example`), latest commit pushed and deployed.
- [ ] Submitted before **Nov 12, 12:00 PM PST**, and the confirmation email received.
