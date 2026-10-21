import type { LanguageModelV4, LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { APICallError } from 'ai';
import { safeErrorMessage, type Logger } from '../lib/safe-error.js';
import { LongRateLimitError } from './rate-limit.js';

/**
 * Groq → Gemini → NVIDIA NIM. One model object the agent talks to; behind it, each call
 * goes to the first provider that isn't benched.
 *
 * - Quota gone (LongRateLimitError from rate-limit.ts, e.g. Groq's 200k tokens/day):
 *   bench that provider for max(its wait, 1h) — the "rest of the day" — and move on.
 *   The 1h floor stops flapping: Groq's daily window is rolling, so it frees a few tokens
 *   every few minutes and would otherwise bounce us back and forth.
 * - Provider unavailable (5xx after the AI SDK's own retries, e.g. Gemini 503 "high
 *   demand"): skip it for this call only, don't bench.
 * - Anything else (bad request, auth…): thrown — another provider wouldn't fix it.
 * - Nobody left → AllProvidersExhaustedError → honest "AI quota used up" reply.
 *
 * Switching mid-run is fine: the AI SDK hands every provider the same normalised
 * prompt, so step 1 on Groq and step 2 on Gemini works.
 */
export const MIN_BENCH_MS = 60 * 60_000;

export interface ProviderSlot {
  name: string;
  model: LanguageModelV4;
}

export class AllProvidersExhaustedError extends Error {
  constructor(readonly retryInMs: number) {
    super(`all LLM providers exhausted: retry in ~${Math.ceil(retryInMs / 60_000)} min`);
    this.name = 'AllProvidersExhaustedError';
  }
}

const isUnavailable = (err: unknown) => APICallError.isInstance(err) && (err.statusCode ?? 0) >= 500;

export class FailoverModel implements LanguageModelV4 {
  readonly specificationVersion = 'v4' as const;
  readonly provider = 'failover';
  readonly supportedUrls = {};
  private readonly benchedUntil = new Map<string, number>();

  constructor(
    private readonly slots: ProviderSlot[],
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {
    if (slots.length === 0) throw new Error('FailoverModel needs at least one provider');
  }

  get modelId(): string {
    return this.slots.map((s) => s.name).join('>');
  }

  /** Which provider the next call would use (for logs/tests). */
  current(): string | undefined {
    return this.slots.find((s) => !this.isBenched(s.name))?.name;
  }

  private isBenched(name: string): boolean {
    const until = this.benchedUntil.get(name);
    if (until === undefined) return false;
    if (this.now() >= until) {
      this.benchedUntil.delete(name);
      this.log.info({ provider: name }, 'LLM provider back in rotation');
      return false;
    }
    return true;
  }

  private async run<T>(call: (model: LanguageModelV4) => PromiseLike<T>): Promise<T> {
    let lastUnavailable: unknown;
    const available = this.slots.filter((s) => !this.isBenched(s.name));
    for (const [i, slot] of available.entries()) {
      try {
        return await call(slot.model);
      } catch (err) {
        const next = available[i + 1]?.name ?? 'none';
        if (err instanceof LongRateLimitError) {
          const benchMs = Math.max(err.waitMs, MIN_BENCH_MS);
          this.benchedUntil.set(slot.name, this.now() + benchMs);
          this.log.warn(
            { provider: slot.name, next, benchedMinutes: Math.round(benchMs / 60_000) },
            'LLM provider quota exhausted — failing over',
          );
          continue;
        }
        if (isUnavailable(err)) {
          lastUnavailable = err;
          this.log.warn({ provider: slot.name, next, error: safeErrorMessage(err) }, 'LLM provider unavailable — failing over');
          continue;
        }
        throw err;
      }
    }
    // If a provider was merely down, quota isn't the whole story: report that error instead.
    if (lastUnavailable) throw lastUnavailable;
    const soonest = Math.min(...[...this.benchedUntil.values()].map((t) => t - this.now()));
    throw new AllProvidersExhaustedError(Number.isFinite(soonest) ? Math.max(0, soonest) : MIN_BENCH_MS);
  }

  doGenerate(options: LanguageModelV4CallOptions) {
    // Not every provider reports a model id (Gemini doesn't), so stamp the one that answered —
    // the reasoning log shows which provider served each step.
    return this.run(async (m) => {
      const result = await m.doGenerate(options);
      return { ...result, response: { ...result.response, modelId: result.response?.modelId ?? m.modelId } };
    });
  }

  doStream(options: LanguageModelV4CallOptions) {
    return this.run((m) => m.doStream(options));
  }
}
