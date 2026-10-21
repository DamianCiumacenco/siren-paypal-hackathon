import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV4 } from '@ai-sdk/provider';
import { wrapLanguageModel, type LanguageModel } from 'ai';
import type { Config } from '../config.js';
import type { Logger } from '../lib/safe-error.js';
import { FailoverModel, type ProviderSlot } from './failover.js';
import { geminiClassifier, groqClassifier, nvidiaClassifier, rateLimitMiddleware, type RateLimitClassifier } from './rate-limit.js';

/** NVIDIA NIM speaks the OpenAI Chat Completions API. */
export const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

type LlmConfig = Pick<
  Config,
  'GROQ_API_KEY' | 'LLM_MODEL' | 'LLM_PROVIDER' | 'GOOGLE_GENERATIVE_AI_API_KEY' | 'GEMINI_MODEL' | 'NVIDIA_API_KEY' | 'NVIDIA_MODEL'
>;

const withRateLimits = (model: LanguageModelV4, provider: string, classify: RateLimitClassifier) =>
  wrapLanguageModel({ model, middleware: rateLimitMiddleware({ provider, classify }) });

/** Provider chain in failover order. Providers without an API key are skipped. */
export function providerSlots(config: LlmConfig): ProviderSlot[] {
  const slots: ProviderSlot[] = [
    {
      name: 'groq',
      model: withRateLimits(createGroq({ apiKey: config.GROQ_API_KEY })(config.LLM_MODEL), 'groq', groqClassifier),
    },
  ];
  if (config.GOOGLE_GENERATIVE_AI_API_KEY) {
    slots.push({
      name: 'gemini',
      model: withRateLimits(
        createGoogleGenerativeAI({ apiKey: config.GOOGLE_GENERATIVE_AI_API_KEY })(config.GEMINI_MODEL),
        'gemini',
        geminiClassifier,
      ),
    });
  }
  if (config.NVIDIA_API_KEY) {
    // .chat(): NIM implements Chat Completions, not OpenAI's Responses API (the SDK default).
    const nvidia = createOpenAI({ apiKey: config.NVIDIA_API_KEY, baseURL: NVIDIA_BASE_URL, name: 'nvidia' });
    slots.push({ name: 'nvidia', model: withRateLimits(nvidia.chat(config.NVIDIA_MODEL), 'nvidia', nvidiaClassifier) });
  }
  // LLM_PROVIDER=google starts the chain at Gemini (Groq stays as a later fallback).
  if (config.LLM_PROVIDER === 'google') slots.sort((a, b) => Number(b.name === 'gemini') - Number(a.name === 'gemini'));
  return slots;
}

const consoleLog: Logger = {
  info: (o, m) => console.log(m, JSON.stringify(o)),
  warn: (o, m) => console.warn(m, JSON.stringify(o)),
  error: (o, m) => console.error(m, JSON.stringify(o)),
};

let shared: FailoverModel | undefined;
let sharedLog: Logger = consoleLog;

/** Route LLM failover logs into the app logger (call once at startup). */
export function setLlmLogger(log: Logger): void {
  sharedLog = log;
}

/**
 * The agent's model: Groq → Gemini → NVIDIA failover. One shared instance so a benched
 * provider (daily quota gone) stays benched across agent runs, not just within one.
 */
export function getModel(config: LlmConfig): LanguageModel {
  // Proxy the logger so setLlmLogger after first use still takes effect.
  shared ??= new FailoverModel(providerSlots(config), {
    info: (o, m) => sharedLog.info(o, m),
    warn: (o, m) => sharedLog.warn(o, m),
    error: (o, m) => sharedLog.error(o, m),
  });
  return shared;
}
