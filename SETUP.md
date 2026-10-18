# Bluey — Setup (Damian's manual tasks)

Do these BEFORE handing to the build-AI. Collect every key in a `.env.local` file as you go. Total time ~45 min.

> **Note**: PayPal Agent Toolkit uses the same Client ID + Secret you create in step 1 — no additional PayPal keys needed. Vercel AI SDK is npm-only, no account required.

---

## 1. PayPal Developer Sandbox (15 min)

1. Go to <https://developer.paypal.com/dashboard/>
2. Sign in with your PayPal account (create one if needed)
3. **Apps & Credentials → Sandbox tab → Create App**
   - App name: `Bluey Dev`
   - Type: Merchant
4. Copy **Client ID** and **Secret** → save as `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`
   - These are what both the PayPal Agent Toolkit AND the webhook verifier use.
5. **Sandbox → Accounts → Create Account (x4, Personal, country: Ireland)**:
   - `damian@sandbox.test` (you, buyer)
   - `jay@sandbox.test` (test mate 1)
   - `sean@sandbox.test` (test mate 2)
   - `mike@sandbox.test` (test mate 3)
   - Save each password in your password manager
6. Note the auto-created Business account — this is who Bluey "invoices from"
7. **Webhooks** (do after Render deploy — leave `PAYPAL_WEBHOOK_ID` blank for now)

## 2. Telegram Bot (5 min)

1. Open Telegram → search `@BotFather`
2. `/newbot`
3. Name: `Bluey`
4. Handle: `@bluey_pay_bot` (must end `_bot`; try variants if taken)
5. Save the bot token → `TELEGRAM_BOT_TOKEN`
6. `/setprivacy` → choose Bluey → **Disable** (so bot can read group messages, not just @mentions)
7. `/setcommands` → paste exactly:
   ```
   start - Setup Bluey in this chat
   split - Start a new bill split
   status - Show current split status
   nag - Remind unpaid members
   help - How to use Bluey
   bluey - Memory / debt / tone commands
   ```

## 3. Groq API (2 min)

1. <https://console.groq.com/keys> → sign in with Google
2. Create API Key → save as `GROQ_API_KEY`
3. Model locked: `openai/gpt-oss-120b` (tool-calling capable)

## 4. Gemini (fallback, 2 min)

1. <https://aistudio.google.com/app/apikey>
2. Create API key → save as `GEMINI_API_KEY`

## 5. Supabase (10 min)

1. <https://supabase.com> → sign in with GitHub
2. **New project**: name `bluey`, region `EU-West (Dublin)`
3. Set a strong database password → save
4. **Settings → API** → copy:
   - `URL` → `SUPABASE_URL`
   - `anon public key` → `SUPABASE_ANON_KEY`
   - `service_role key` → `SUPABASE_SERVICE_KEY` (⚠️ server-only, never ship to client)

## 6. GitHub repo (5 min)

1. New repo: `bluey-paypal-hackathon`
2. **Public**, add MIT license, add Node `.gitignore`
3. Clone locally — build-AI commits into this

## 7. Render account (5 min — finish after code is pushed)

1. <https://render.com> → sign in with GitHub
2. Keep tab open; you'll create the Web Service once the repo exists

## 8. UptimeRobot (5 min — after Render deploy)

1. <https://uptimerobot.com> → free account
2. Add HTTP(s) monitor → point at your Render URL `/health`
3. Interval: **10 min** (keeps Render warm for the judge demo)

---

## `.env.local` template — fill as you go

```
# PayPal (used by both @paypal/agent-toolkit AND our webhook verifier)
PAYPAL_CLIENT_ID=
PAYPAL_CLIENT_SECRET=
PAYPAL_MODE=sandbox
PAYPAL_WEBHOOK_ID=            # fill after webhook created (step 1.7)

# Telegram
TELEGRAM_BOT_TOKEN=

# LLM (Vercel AI SDK providers)
GROQ_API_KEY=
GOOGLE_GENERATIVE_AI_API_KEY= # same value as GEMINI_API_KEY; @ai-sdk/google reads this name
LLM_PROVIDER=groq
LLM_MODEL=openai/gpt-oss-120b

# Supabase
SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_KEY=

# App
PORT=3000
PUBLIC_URL=                   # fill with Render URL after deploy, e.g. https://bluey.onrender.com
```

---

## Handoff to build-AI (Claude Code)

Give it exactly these four files in the repo:
- `SCOPE.md`
- `SETUP.md`
- `ARCHITECTURE.md`
- `CLAUDE.md` (auto-loaded context — see repo root)

Say: **"Read CLAUDE.md. Start milestone 1–2 per ARCHITECTURE.md. Stop after for review."**
