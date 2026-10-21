# Siren

Autonomous Telegram payment agent built on the official **PayPal Agent Toolkit** + **Vercel AI SDK**, Groq-powered with Gemini fallback, Supabase memory, and a scheduled runner that lets the agent decide for itself when to follow up. Submitted to the PayPal AI Hackathon 2026 under **Agentic Commerce** + **Best Use of PayPal + AI**.

> **Built on [PayPal Agent Toolkit](https://github.com/paypal/agent-toolkit)** — all outbound PayPal calls go through the official toolkit.

🚧 Work in progress — full README (architecture, tool catalogue, judge setup) lands before submission.

## Local development

Requires Node 22+ and the [Supabase CLI](https://supabase.com/docs/guides/cli).

```bash
npm install
cp .env.example .env.local   # fill in values (see SETUP.md)
npm run db:push              # apply src/db/schema.sql to Supabase
npm run db:check             # verify tables exist
npm run dev                  # Fastify + Telegram bot (long polling when PUBLIC_URL is blank)
npm test
```

## Known issues

- **`npm audit` reports 10 vulnerabilities (3 low, 2 moderate, 5 high).** All of them are in transitive dependencies of `@paypal/agent-toolkit` (e.g. `mathjs`, `langsmith`, `uuid`), and there is no upstream fix yet: the only automated fix (`npm audit fix --force`) downgrades the toolkit to 1.3.5, which is a breaking change. Siren runs in PayPal sandbox only. We'll bump the toolkit when PayPal ships a fix.

- **Design decision (v2 scope): pay-link fallback in the group chat.** If a member has never opened a private chat with Siren, Telegram won't let the bot DM them, so their PayPal pay link is posted in the group instead. That's fine in sandbox, but in production any group member could open that link and pay someone else's share. A production version should ask the member to DM the bot first (a "tap here to get your link" deep link) rather than post the link publicly.

## License

MIT — see [LICENSE](LICENSE).
