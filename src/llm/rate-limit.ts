import { APICallError, type LanguageModelMiddleware } from 'ai';

/**
 * Per-provider 429 handling. Every free tier we use has a short window (wait it out) and
 * a long one (quota gone for hours: hand over to the next provider, see failover.ts):
 *
 *   Groq    8k tokens/min → retry-after of a few seconds;  200k tokens/day → retry-after > 60s
 *   Gemini  per-minute quota → body RetryInfo "retryDelay";  per-day quota → "PerDay" quota id
 *   NVIDIA  free dev credits: a 429 means they're used up (no billing → no other failure mode)
 *
 * The AI SDK's own retry only honours retry-after ≤ 60s and otherwise backs off
 * exponentially (2s … 1024s), which could hang a run ~30 min while holding the group's
 * agent lock. So 429s are handled here; generateText keeps its retries for 5xx only.
 */
export const MAX_WAIT_MS = 60_000;
export const MAX_RATE_LIMIT_RETRIES = 12;

export type RateLimitVerdict = { kind: 'wait'; ms: number } | { kind: 'exhausted'; ms: number };
export type RateLimitClassifier = (err: APICallError, attempt: number) => RateLimitVerdict;

/** Thrown when a provider's quota is gone for longer than MAX_WAIT_MS (failover catches it). */
export class LongRateLimitError extends Error {
  constructor(
    readonly waitMs: number,
    readonly provider = 'llm',
  ) {
    super(`${provider} quota exhausted: retry in ~${Math.ceil(waitMs / 60_000)} min`);
    this.name = 'LongRateLimitError';
  }
}

/** retry-after (seconds or HTTP date) / retry-after-ms header, in ms. */
export function retryAfterMs(err: APICallError): number | undefined {
  const h = err.responseHeaders ?? {};
  if (h['retry-after-ms'] && !Number.isNaN(Number(h['retry-after-ms']))) return Number(h['retry-after-ms']);
  const ra = h['retry-after'];
  if (!ra) return undefined;
  const secs = Number(ra);
  return Number.isNaN(secs) ? Math.max(0, Date.parse(ra) - Date.now()) : secs * 1000;
}

const HOUR = 3_600_000;
const backoff = (attempt: number) => 2000 * 2 ** attempt;
const byWait = (ms: number): RateLimitVerdict => (ms > MAX_WAIT_MS ? { kind: 'exhausted', ms } : { kind: 'wait', ms });

/** Groq: the retry-after header tells us which window we hit. */
export const groqClassifier: RateLimitClassifier = (err, attempt) => byWait(retryAfterMs(err) ?? backoff(attempt));

/** Gemini: 429 RESOURCE_EXHAUSTED; the body names the quota ("…PerDay…") and a retryDelay ("34s"). */
export const geminiClassifier: RateLimitClassifier = (err, attempt) => {
  const body = err.responseBody ?? '';
  if (/PerDay|per day/i.test(body)) return { kind: 'exhausted', ms: HOUR }; // daily quota resets at midnight PT
  const delay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body)?.[1];
  return byWait(delay ? Number(delay) * 1000 : (retryAfterMs(err) ?? backoff(attempt)));
};

/** NVIDIA NIM free dev tier: a 429 means the credits are gone (unless it says to wait briefly). */
export const nvidiaClassifier: RateLimitClassifier = (err) => {
  const ms = retryAfterMs(err);
  return ms !== undefined && ms <= MAX_WAIT_MS ? { kind: 'wait', ms } : { kind: 'exhausted', ms: 24 * HOUR };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function rateLimitMiddleware(
  opts: { classify?: RateLimitClassifier; provider?: string; sleep?: (ms: number) => Promise<void> } = {},
): LanguageModelMiddleware {
  const wait = opts.sleep ?? sleep;
  const classify = opts.classify ?? groqClassifier;
  return {
    specificationVersion: 'v4',
    wrapGenerate: async ({ doGenerate }) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await doGenerate();
        } catch (err) {
          if (!APICallError.isInstance(err) || err.statusCode !== 429) throw err;
          const verdict = classify(err, attempt);
          if (verdict.kind === 'exhausted') throw new LongRateLimitError(verdict.ms, opts.provider);
          if (attempt >= MAX_RATE_LIMIT_RETRIES) throw err;
          await wait(verdict.ms + 250); // small margin so the window has actually rolled over
        }
      }
    },
  };
}
