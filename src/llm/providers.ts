import { createGroq } from '@ai-sdk/groq';
import type { LanguageModel } from 'ai';
import type { Config } from '../config.js';

/**
 * The agent's model. Groq only for now (LLM_MODEL, default openai/gpt-oss-120b —
 * tool-calling capable). Gemini fallback + prompt cache land in milestone 12.
 */
export function getModel(config: Pick<Config, 'GROQ_API_KEY' | 'LLM_MODEL'>): LanguageModel {
  return createGroq({ apiKey: config.GROQ_API_KEY })(config.LLM_MODEL);
}
