import { generateText, stepCountIs, type LanguageModel, type ToolSet } from 'ai';
import { loadConfig } from '../config.js';
import { getDb } from '../db/client.js';
import { loadGroupContext } from '../db/group_context.js';
import { insertReasoningLog } from '../db/reasoning_log.js';
import { getModel } from '../llm/providers.js';
import { summariseSteps, type ReasoningRecord, type Thought } from './reasoning-log.js';
import { buildSystemPrompt } from './system-prompt.js';
import { getAllTools } from './tools/index.js';
import type { AgentInput, GroupContext } from './types.js';

/** Hard cap on agent steps (CLAUDE.md). Each step = one LLM call + its tool calls. */
export const MAX_AGENT_STEPS = 6;

export interface AgentOutput {
  response: string;
  thoughts: Thought[];
}

/** Everything runAgent talks to. Defaults are the real services; tests swap them. */
export interface AgentDeps {
  model: LanguageModel;
  tools: ToolSet;
  groupContext: GroupContext | undefined;
  persist: (record: ReasoningRecord) => Promise<void>;
}

async function defaultDeps(input: AgentInput): Promise<AgentDeps> {
  const config = loadConfig();
  const db = getDb();
  return {
    model: getModel(config),
    tools: getAllTools(input.context, { config }),
    groupContext: await loadGroupContext(db, input.context.groupId),
    persist: (record) => insertReasoningLog(db, record),
  };
}

/** Single entry point for the agent: one call = one generateText tool loop. */
export async function runAgent(input: AgentInput, overrides: Partial<AgentDeps> = {}): Promise<AgentOutput> {
  const complete = overrides.model && overrides.tools && 'groupContext' in overrides && overrides.persist;
  const deps: AgentDeps = complete ? (overrides as AgentDeps) : { ...(await defaultDeps(input)), ...overrides };

  const result = await generateText({
    model: deps.model,
    system: buildSystemPrompt(input, deps.groupContext),
    prompt: input.userMessage,
    tools: deps.tools,
    stopWhen: stepCountIs(MAX_AGENT_STEPS),
  });

  const thoughts = summariseSteps(result.steps);
  // If the loop hit the step cap mid-tool-use there's no final text — say so rather than post nothing.
  const response = result.text.trim() || 'I ran out of steps before finishing — try asking again more specifically.';

  // Persist regardless of outcome: the reasoning log is how `/siren why` explains decisions.
  await deps.persist({
    groupId: input.context.groupId,
    splitId: input.context.splitId,
    trigger: input.trigger,
    thoughts,
    finalResponse: response,
  });
  return { response, thoughts };
}
