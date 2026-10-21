import { APICallError, type LanguageModelMiddleware } from 'ai';

/**
 * Groq's free tier has TWO limits, and they need opposite handling:
 * - 8k tokens/MINUTE: a 3-step agent run can't fit in one minute, so wait it out
 *   (Groq's retry-after is a few seconds) and the run completes.
 * - 200k tokens/DAY: retry-after is minutes to hours. Waiting would hold the group's
 *   agent lock for that long, so fail fast and tell the user when to retry.
 *
 * The AI SDK's own retry only honours retry-after ≤ 60s and otherwise falls back to
 * exponential backoff (2s, 4s … 1024s), which is the worst of both. So 429s are handled
 * here and rethrown as non-retryable once we give up; generateText keeps its default
 * retries for transient 5xx errors only.
 */
export const MAX_WAIT_MS = 60_000;
export const MAX_RATE_LIMIT_RETRIES = 12;

/** retry-after (seconds or HTTP date) / retry-after-ms, in ms. */
export function retryAfterMs(err: APICallError): number | undefined {
  const h = err.responseHeaders ?? {};
  if (h['retry-after-ms'] && !Number.isNaN(Number(h['retry-after-ms']))) return Number(h['retry-after-ms']);
  const ra = h['retry-after'];
  if (!ra) return undefined;
  const secs = Number(ra);
  return Number.isNaN(secs) ? Math.max(0, Date.parse(ra) - Date.now()) : secs * 1000;
}

/** Thrown when the provider asks us to wait longer than MAX_WAIT_MS (e.g. daily cap). */
export class LongRateLimitError extends Error {
  constructor(readonly waitMs: number) {
    super(`LLM rate limit: retry in ~${Math.ceil(waitMs / 60_000)} min`);
    this.name = 'LongRateLimitError';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function rateLimitMiddleware(opts: { sleep?: (ms: number) => Promise<void> } = {}): LanguageModelMiddleware {
  const wait = opts.sleep ?? sleep;
  return {
    specificationVersion: 'v4',
    wrapGenerate: async ({ doGenerate }) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await doGenerate();
        } catch (err) {
          if (!APICallError.isInstance(err) || err.statusCode !== 429) throw err;
          const ms = retryAfterMs(err) ?? 2000 * 2 ** attempt;
          if (ms > MAX_WAIT_MS) throw new LongRateLimitError(ms);
          if (attempt >= MAX_RATE_LIMIT_RETRIES) throw err;
          await wait(ms + 250); // small margin so the window has actually rolled over
        }
      }
    },
  };
}
