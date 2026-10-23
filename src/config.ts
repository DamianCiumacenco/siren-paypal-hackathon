import { existsSync } from 'node:fs';
import { validate as isValidCron } from 'node-cron';
import { z } from 'zod';

// Empty strings in .env files (e.g. `PAYPAL_WEBHOOK_ID=`) should count as "not set".
const optional = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));
const required = z.string({ error: 'is missing' }).trim().min(1, 'is empty');

const envSchema = z.object({
  // PayPal
  PAYPAL_CLIENT_ID: required,
  PAYPAL_CLIENT_SECRET: required,
  PAYPAL_MODE: z.literal('sandbox').default('sandbox'), // sandbox only — see SCOPE.md hard limits
  PAYPAL_WEBHOOK_ID: optional, // filled after Render deploy
  // Accept Webhook Simulator events (signed with webhook id "WEBHOOK_ID"). Testing only:
  // anyone can fire the simulator at our URL, so keep this off on the live deploy.
  PAYPAL_WEBHOOK_ALLOW_SIMULATOR: z
    .enum(['true', 'false', ''])
    .optional()
    .transform((v) => v === 'true'),

  // Telegram
  TELEGRAM_BOT_TOKEN: required,

  // LLM
  GROQ_API_KEY: required,
  // Failover chain: Groq → Gemini → NVIDIA NIM (src/llm/). Fallbacks are skipped if no key.
  LLM_PROVIDER: z.enum(['groq', 'google']).default('groq'), // where the chain starts
  LLM_MODEL: z.string().trim().min(1).default('openai/gpt-oss-120b'), // Groq model
  GOOGLE_GENERATIVE_AI_API_KEY: optional,
  // gemini-2.5-flash is closed to new users; 3.7/3.8 were overloaded (503) when tested.
  GEMINI_MODEL: z.string().trim().min(1).default('gemini-3.5-flash'),
  NVIDIA_API_KEY: optional,
  // nemotron-3-super-120b-a12b is listed but "not found for account" on the free dev key.
  NVIDIA_MODEL: z.string().trim().min(1).default('nvidia/nemotron-3-ultra-550b-a55b'),

  // Supabase
  SUPABASE_URL: z.url({ error: 'is missing or not a valid URL' }),
  SUPABASE_ANON_KEY: optional,
  SUPABASE_SERVICE_KEY: required,
  SUPABASE_DB_URL: optional, // only used by `npm run db:push`

  // Autonomous scheduler (milestone 11). Prod: every 6h. Demo/mates test: '*/5 * * * *'.
  NAG_CRON_INTERVAL: z
    .string()
    .trim()
    .default('0 */6 * * *')
    .refine((v) => isValidCron(v), 'is not a valid cron expression (e.g. "0 */6 * * *")'),

  // App
  PORT: z.coerce.number().int().positive().default(3000),
  // Deployed URL (e.g. https://siren-xxxx.onrender.com). Set → Telegram webhook mode.
  // Unset → local dev with long polling. Trailing slash stripped so URLs join cleanly.
  PUBLIC_URL: optional.pipe(z.url().optional()).transform((v) => v?.replace(/\/+$/, '')),
  // Local only: take Telegram over from a live production webhook (see server.ts).
  TELEGRAM_FORCE_POLLING: z
    .enum(['true', 'false', ''])
    .optional()
    .transform((v) => v === 'true'),
  // E2E suite (milestone 14). Set → /e2e/* routes exist and Telegram calls to chats the
  // suite registers are captured instead of sent (src/e2e/sink.ts). Unset → none of it exists.
  E2E_SECRET: optional.pipe(z.string().min(32, 'must be at least 32 characters').optional()),
});

export type Config = z.infer<typeof envSchema>;

/** Validate an env object. Throws one error listing every bad/missing var. */
export function parseConfig(env: Record<string, string | undefined>): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(
      `Invalid environment configuration:\n${lines.join('\n')}\n` +
        'Fix these in .env.local (see .env.example for the full list).',
    );
  }
  return result.data;
}

let cached: Config | undefined;

/** Load .env.local (if present — on Render vars come from the dashboard) and validate. */
export function loadConfig(): Config {
  if (cached) return cached;
  if (existsSync('.env.local')) process.loadEnvFile('.env.local');
  cached = parseConfig(process.env);
  return cached;
}
