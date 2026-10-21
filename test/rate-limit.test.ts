import { APICallError, wrapLanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { runAgent } from '../src/agent/run.js';
import { failureMessage } from '../src/bot/handlers/message.js';
import { LongRateLimitError, rateLimitMiddleware } from '../src/llm/rate-limit.js';
import { textStep } from './helpers/mock-model.js';

function groq429(retryAfter: string, kind: 'TPM' | 'TPD') {
  return new APICallError({
    message: 'Rate limit reached',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    requestBodyValues: {},
    statusCode: 429,
    responseHeaders: { 'retry-after': retryAfter },
    responseBody: `{"error":{"message":"Rate limit reached ... tokens per ${kind === 'TPM' ? 'minute (TPM)' : 'day (TPD)'}"}}`,
    isRetryable: true,
  });
}

/** Model that throws the given errors first, then answers. Records waits instead of sleeping. */
function setup(errors: APICallError[]) {
  let calls = 0;
  const waits: number[] = [];
  const base = new MockLanguageModelV4({
    doGenerate: async () => {
      const e = errors[calls++];
      if (e) throw e;
      return textStep('done');
    },
  });
  const model = wrapLanguageModel({ model: base, middleware: rateLimitMiddleware({ sleep: async (ms) => void waits.push(ms) }) });
  const run = () =>
    runAgent(
      { trigger: 'user_message', userMessage: 'hi', context: { groupId: 1, chatId: -1 } },
      { model, tools: {}, groupContext: undefined, persist: async () => {} },
    );
  return { run, waits, calls: () => calls };
}

describe('LLM rate limits (Groq free tier)', () => {
  it('per-minute limit: waits for each retry-after and the run completes', async () => {
    const { run, waits, calls } = setup([groq429('9', 'TPM'), groq429('4', 'TPM'), groq429('3', 'TPM')]);
    expect((await run()).response).toBe('done');
    expect(calls()).toBe(4);
    expect(waits).toEqual([9250, 4250, 3250]); // retry-after + 250ms margin
  });

  it('daily limit (retry-after 8 min): fails fast with the real wait — no 30-minute backoff hang', async () => {
    const { run, waits, calls } = setup([groq429('495', 'TPD')]);
    const started = Date.now();
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LongRateLimitError);
    expect((err as LongRateLimitError).waitMs).toBe(495_000);
    expect(calls()).toBe(1); // not retried by the middleware or by the AI SDK
    expect(waits).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('non-429 errors are left to the AI SDK (transient 5xx retries)', async () => {
    const e500 = new APICallError({ message: 'oops', url: 'x', requestBodyValues: {}, statusCode: 503, isRetryable: true });
    const { run, calls } = setup([e500]);
    expect((await run()).response).toBe('done');
    expect(calls()).toBe(2);
  });
});

describe('failureMessage (what the group sees)', () => {
  it('daily quota → tells them roughly when to retry', () => {
    expect(failureMessage(new LongRateLimitError(495_000))).toMatch(/daily limit.*about 9 minutes/);
    expect(failureMessage(new LongRateLimitError(4 * 3_600_000))).toMatch(/about 4 hours/);
  });

  it('per-minute 429 that still failed → try again in a minute', () => {
    expect(failureMessage(groq429('5', 'TPM'))).toMatch(/try again in a minute/);
  });

  it('anything else → generic apology (no error details)', () => {
    expect(failureMessage(new Error('db exploded: Jay Murphy'))).toBe('Sorry, something went wrong on my side. Try again in a minute.');
  });
});
