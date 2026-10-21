import { APICallError, wrapLanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { runAgent } from '../src/agent/run.js';
import { failureMessage } from '../src/bot/handlers/message.js';
import type { Logger } from '../src/lib/safe-error.js';
import { AllProvidersExhaustedError, FailoverModel, MIN_BENCH_MS } from '../src/llm/failover.js';
import { providerSlots } from '../src/llm/providers.js';
import {
  geminiClassifier,
  groqClassifier,
  nvidiaClassifier,
  rateLimitMiddleware,
  type RateLimitClassifier,
} from '../src/llm/rate-limit.js';
import { textStep } from './helpers/mock-model.js';

const err = (status: number, opts: { retryAfter?: string; body?: string } = {}) =>
  new APICallError({
    message: `HTTP ${status}`,
    url: 'https://llm.example/v1',
    requestBodyValues: { prompt: 'Members: Jay Murphy owes €60' }, // must never reach logs
    statusCode: status,
    responseHeaders: opts.retryAfter ? { 'retry-after': opts.retryAfter } : {},
    responseBody: opts.body ?? '{"error":{"message":"rate limited"}}',
    isRetryable: status === 429 || status >= 500,
  });

// Realistic bodies/headers for each provider's limits.
const GROQ_TPM = () => err(429, { retryAfter: '4', body: '{"error":{"message":"... tokens per minute (TPM): Limit 8000"}}' });
const GROQ_TPD = () => err(429, { retryAfter: '495', body: '{"error":{"message":"... tokens per day (TPD): Limit 200000"}}' });
const GEMINI_RPM = () =>
  err(429, { body: '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"},{"retryDelay":"7s"}]}}' });
const GEMINI_RPD = () =>
  err(429, { body: '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"},{"retryDelay":"20s"}]}}' });
const GEMINI_503 = () => err(503, { body: '{"error":{"code":503,"message":"This model is currently experiencing high demand."}}' });
const NVIDIA_429 = () => err(429, { body: '{"status":429,"title":"Too Many Requests"}' });

/** A provider whose next responses are scripted: an APICallError to throw, or 'ok'. */
function provider(name: string, classify: RateLimitClassifier, script: (APICallError | 'ok')[]) {
  const calls = { n: 0 };
  const waits: number[] = [];
  const base = new MockLanguageModelV4({
    provider: name,
    doGenerate: async () => {
      const next = script[calls.n++] ?? 'ok';
      if (next !== 'ok') throw next;
      return textStep(`answer from ${name}`);
    },
  });
  const model = wrapLanguageModel({
    model: base,
    middleware: rateLimitMiddleware({ provider: name, classify, sleep: async (ms) => void waits.push(ms) }),
  });
  return { slot: { name, model }, calls, waits };
}

function chain(scripts: { groq?: (APICallError | 'ok')[]; gemini?: (APICallError | 'ok')[]; nvidia?: (APICallError | 'ok')[] }) {
  const groq = provider('groq', groqClassifier, scripts.groq ?? []);
  const gemini = provider('gemini', geminiClassifier, scripts.gemini ?? []);
  const nvidia = provider('nvidia', nvidiaClassifier, scripts.nvidia ?? []);
  const logs: string[] = [];
  const log: Logger = {
    info: (o, m) => logs.push(JSON.stringify({ ...o, msg: m })),
    warn: (o, m) => logs.push(JSON.stringify({ ...o, msg: m })),
    error: (o, m) => logs.push(JSON.stringify({ ...o, msg: m })),
  };
  let now = Date.parse('2026-10-21T12:00:00Z');
  const model = new FailoverModel([groq.slot, gemini.slot, nvidia.slot], log, () => now);
  const ask = () =>
    runAgent(
      { trigger: 'user_message', userMessage: 'hi', context: { groupId: 1, chatId: -1 } },
      { model, tools: {}, groupContext: undefined, persist: async () => {} },
    );
  return { model, ask, logs, groq, gemini, nvidia, advance: (ms: number) => (now += ms) };
}

describe('LLM failover chain: Groq → Gemini → NVIDIA', () => {
  it('Groq per-minute cap → waits for retry-after and stays on Groq', async () => {
    const c = chain({ groq: [GROQ_TPM(), GROQ_TPM()] });
    expect((await c.ask()).response).toBe('answer from groq');
    expect(c.groq.waits).toEqual([4250, 4250]);
    expect(c.gemini.calls.n).toBe(0);
  });

  it('Groq daily cap → Gemini answers, the switch is logged, user sees no error', async () => {
    const c = chain({ groq: [GROQ_TPD()] });
    expect((await c.ask()).response).toBe('answer from gemini');
    expect(c.groq.waits).toEqual([]); // no waiting on a daily cap
    expect(c.logs.join()).toContain('"provider":"groq","next":"gemini"');
    expect(c.logs.join()).toContain('quota exhausted');
  });

  it('…and Groq stays benched for the rest of the day (≥1h), then comes back', async () => {
    const c = chain({ groq: [GROQ_TPD()] });
    await c.ask();
    await c.ask();
    expect(c.groq.calls.n).toBe(1); // second run went straight to Gemini
    expect(c.model.current()).toBe('gemini');
    c.advance(MIN_BENCH_MS + 1);
    expect((await c.ask()).response).toBe('answer from groq');
    expect(c.logs.join()).toContain('back in rotation');
  });

  it('Gemini per-minute quota → waits for its retryDelay, stays on Gemini', async () => {
    const c = chain({ groq: [GROQ_TPD()], gemini: [GEMINI_RPM()] });
    expect((await c.ask()).response).toBe('answer from gemini');
    expect(c.gemini.waits).toEqual([7250]);
  });

  it('Gemini daily quota → NVIDIA answers, logged', async () => {
    const c = chain({ groq: [GROQ_TPD()], gemini: [GEMINI_RPD()] });
    expect((await c.ask()).response).toBe('answer from nvidia');
    expect(c.logs.join()).toContain('"provider":"gemini","next":"nvidia"');
  });

  it('Gemini overloaded (503) → NVIDIA for this call, Gemini not benched', async () => {
    const c = chain({ groq: [GROQ_TPD()], gemini: [GEMINI_503(), GEMINI_503(), GEMINI_503()] });
    expect((await c.ask()).response).toBe('answer from nvidia');
    expect(c.logs.join()).toContain('unavailable');
    expect(c.model.current()).toBe('gemini'); // still first choice after Groq
  });

  it('NVIDIA 429 (credits gone) after the others → honest "quota used up", no crash', async () => {
    const c = chain({ groq: [GROQ_TPD()], gemini: [GEMINI_RPD()], nvidia: [NVIDIA_429()] });
    const e = await c.ask().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AllProvidersExhaustedError);
    expect(c.nvidia.waits).toEqual([]);
    // Soonest comeback = Groq's 1h bench floor.
    expect(failureMessage(e)).toMatch(/AI quota is used up on every provider .* Try again in about 60 minutes\./);
  });

  it('non-quota errors (e.g. 400 bad request) are not failed over', async () => {
    const c = chain({ groq: [err(400)] });
    await expect(c.ask()).rejects.toThrow('HTTP 400');
    expect(c.gemini.calls.n).toBe(0);
  });

  it('failover logs contain provider names only — never prompt contents', async () => {
    const c = chain({ groq: [GROQ_TPD()], gemini: [GEMINI_503(), GEMINI_503(), GEMINI_503()] });
    await c.ask();
    for (const pii of ['Jay', 'Murphy', '€60']) expect(c.logs.join()).not.toContain(pii);
  });
});

describe('provider chain config', () => {
  const base = {
    GROQ_API_KEY: 'g',
    LLM_MODEL: 'openai/gpt-oss-120b',
    LLM_PROVIDER: 'groq' as const,
    GEMINI_MODEL: 'gemini-3.5-flash',
    NVIDIA_MODEL: 'nvidia/nemotron-3-ultra-550b-a55b',
  };
  it('orders Groq → Gemini → NVIDIA and skips providers without a key', () => {
    expect(providerSlots({ ...base, GOOGLE_GENERATIVE_AI_API_KEY: 'k', NVIDIA_API_KEY: 'n' }).map((s) => s.name)).toEqual(['groq', 'gemini', 'nvidia']);
    expect(providerSlots({ ...base, GOOGLE_GENERATIVE_AI_API_KEY: undefined, NVIDIA_API_KEY: 'n' }).map((s) => s.name)).toEqual(['groq', 'nvidia']);
  });
  it('LLM_PROVIDER=google starts at Gemini', () => {
    expect(providerSlots({ ...base, LLM_PROVIDER: 'google', GOOGLE_GENERATIVE_AI_API_KEY: 'k', NVIDIA_API_KEY: 'n' }).map((s) => s.name)).toEqual(['gemini', 'groq', 'nvidia']);
  });
});
