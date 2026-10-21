# Testing Siren with us 🧪

Thanks for helping! Siren is a Telegram bot that splits bills and collects money with PayPal. We're testing in **PayPal sandbox**, so **no real money moves**: you'll pay with a fake test account.

It takes about 15 minutes. Please do steps 1–3 **before** the test starts.

## 1. Start a private chat with the bot
Open Telegram, search for **@siren_pay_bot**, open the chat and press **Start**.

Telegram only lets bots message people who've done this. If you skip it, Siren can't DM you your pay link, and it gets posted in the group instead.

## 2. Say hi in the test group
Once you've been added to the test group, send any message there ("hi" is fine).

That's how Siren learns you're in the group, so that when someone writes "/split €24 pizza with Jay, Sean and Mike" it knows who "Jay" is. If someone else in the group has the same first name as you, tell Damian your @username.

## 3. Get your sandbox PayPal login from Damian
Damian will send you a **test PayPal email + password** privately. Only use that one.
- Don't log in with your real PayPal account; the sandbox won't accept it anyway.
- Pay links look like `https://www.sandbox.paypal.com/invoice/p/#…`. The word **sandbox** means it's test money.

## 4. During the test
Damian will tell you what to do. It'll be things like:
- Damian starts a split, e.g. `/split €24 pizza with Jay, Sean and Mike`. Only he can tap ✅ to send the requests.
- You get a DM from Siren with your pay link. Open it, log in with your **sandbox** account and pay.
- A minute or so later, the group should show "✅ <you> paid …".
- Try these in the group:
  - `/status`
  - `/siren debt`
  - `/siren why` (shows how Siren made its last decision)
  - `/siren about <someone>`
  - `/siren tone chill` (or `neutral` / `direct`): how you'd like to be reminded

**If something looks off** (a wrong amount, a DM you didn't expect, a link meant for someone else, or an error message from Siren), screenshot it and send it to Damian. That's exactly what we're looking for.

Running on free tiers Groq → Gemini → NVIDIA auto-failover, no rate concerns. (If Siren ever says its "AI quota is used up on every provider", all three ran out at once, which is very unlikely; tell Damian.)

## Privacy
- Siren stores your Telegram first name and username, plus your test payments, in our test database.
- It's wiped after the test.
- Nothing involves your real PayPal account.

---

### For Damian (host): not for the mates
- **Runbook:** follow "Runbook: manual E2E test in a real Telegram group" in CLAUDE.md. It covers `db:reset`, `npm run dev`, setup order and teardown.
- **Sandbox logins:** send each mate a different sandbox Personal account (SETUP.md §1.5).
- **"Paid" updates:** these need the PayPal webhook → tunnel step (runbook step 4). Without it, payments still go through in the sandbox, but the group never shows "✅ paid".
- **One bot only:** only one copy of the bot can run at a time (no Render deploy during the test).
- **AI quota:** Groq (~25 agent replies/day on the free tier) → Gemini → NVIDIA NIM fail over automatically, and the switch is logged as `LLM provider quota exhausted — failing over`. ✅ taps, payment posts and `/siren why` use no LLM at all.
