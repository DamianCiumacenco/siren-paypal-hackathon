# Demo-day runbook (one page)

Production: `https://siren-5brb.onrender.com` · Bot: `@siren_pay_bot` · Everything is PayPal **sandbox**.
Do FINAL_CHECKLIST.md first. This page is for the hour before recording or presenting.

## Backup video (fill in once recorded)
- **YouTube (unlisted):** `<link>`
- **Local file:** `~/Movies/siren-demo/siren-demo-final.mp4`
- **Google Drive:** `<link>` (downloadable offline copy, in case the venue Wi-Fi is bad)
- Also keep per-scene clips (`scene-1-split.mp4` … `scene-5-why.mp4`) from a known-good take, so you can cut to just the scene that failed.

## 3+ days before: seed the memory (two-tones scene)
Tones are learned from real history and every scheduler pass recomputes them, so you can't set them by hand. Run 2–3 small splits (€1) in the demo group with both mates: **Sean pays within the hour, Jay doesn't pay**. A share only counts as late after 72h, so start at least 3 days early. `/siren about Sean` should show high reliability and a chill tone; `/siren about Jay` should show low reliability and a direct tone.

## T-60 min: warm-up sequence
1. `curl https://siren-5brb.onrender.com/health` should return `"ok":true,"db":"ok","telegram":"webhook"`. The first call can take ~1 min if Render was asleep (it shouldn't be, with UptimeRobot).
2. `npm run verify:live -- https://siren-5brb.onrender.com`: 9 ✓.
3. Recording the autonomous nag? Render → Environment → `NAG_CRON_INTERVAL=*/5 * * * *` → Save and deploy, then wait for the deploy and re-run step 1. Put it back to `0 */6 * * *` afterwards.
4. In the demo group: `/help` (instant) → `/status` (no LLM) → `@siren_pay_bot who still owes?` (the LLM answers in under ~10s). If the reply says the AI quota is used up, record later: Groq's quota is a rolling 24h.
5. Browser: open a separate profile/window **already logged in to `jay@sandbox.test`** on sandbox.paypal.com, so paying is a single click on camera.
6. `/siren dashboard` → open the DM'd link now, because it lasts 24h. Keep the tab open.
7. Telegram: do not disturb on, notifications from other chats muted, font size readable, old test messages scrolled out of view.

## Running order (covers all 7 success criteria)
1. `/split €24 pizza with Jay, Sean and Mike` → the agent's reply and the ✅ card → tap ✅ (criterion 1).
2. Show a mate's DM with their own pay link (criterion 2).
3. Pay Jay's link in the logged-in sandbox tab → "✅ Jay paid … 1/3" in the group, ~20–60s (criterion 3).
4. `/status`: who paid and who hasn't (criterion 4).
5. Wait for the scheduler (or show a recorded pass) → "Reminded …" → `/siren why`: the real steps, e.g. `Tools: get_member_profile ✓ → telegram_dm ✓` (criterion 5).
6. `/siren about Jay` and `/siren about Sean`: learned profiles (criterion 6). Show both reminder DMs side by side, one direct and one chill (criterion 7).
7. Optional: the dashboard tab (agent decisions grid → click one for its steps).

## If something goes wrong
| Symptom | Do this |
|---|---|
| **PayPal sandbox hangs**: the ✅ card stays on "sending PayPal requests…" for more than 60s | Don't tap ✅ again (double taps are ignored anyway). Check https://www.paypal-status.com and the Render logs for `split invoice failed`. Cut to the backup clip for scenes 1–3 and carry on with `/status` and `/siren why`, which need no PayPal. |
| **Sandbox pay page spins / won't log in** | Refresh once, then try the other pre-logged-in sandbox account. Still stuck → backup clip of scene 3. |
| **Paid, but no "✅ paid" post after ~2 min** | The webhook is late or failed. PayPal app → Webhooks → Events shows whether it was sent. `/status` only updates when the webhook arrives, so cut to the backup clip. Don't pay twice. |
| **"AI quota is used up on every provider"** | No LLM needed for: ✅ send, payment posts, `/status`, `/siren why`, `/siren dashboard`. Do those live and use the backup clip for the agent scenes. |
| **"over my AI rate limit"** | Groq allows 8k tokens a minute: wait 60s and repeat. |
| **Bot silent** | `/health` and `verify:live`. `telegram` not `webhook`, or a webhook error → Render → Manual Deploy → Deploy latest commit (re-registers the webhook, ~2 min). |
| **`/health` 503 (`db: error`)** | Supabase is down or paused: check the Supabase dashboard (resume the project). Use the backup video meanwhile. |
| **Render down / deploy failing** | Use the backup video in full. Don't push code on demo day. |

## After
- `NAG_CRON_INTERVAL` back to `0 */6 * * *` if you changed it.
- Leave the demo group and data in place until judging ends (judges may try `/siren why` and the dashboard).
