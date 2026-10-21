import type { StepResult, ToolSet } from 'ai';
import type { AgentInput } from './types.js';

const MAX_FIELD_CHARS = 2000; // PayPal responses can be huge; keep log rows small.

/** One agent step as stored in reasoning_log.thoughts (shown by `/siren why`). */
export interface Thought {
  step: number;
  reasoning?: string;
  text?: string;
  toolCalls: { tool: string; input: unknown }[];
  toolResults: { tool: string; output: unknown }[];
  toolErrors: { tool: string; error: string }[];
  tokens: { input?: number; output?: number };
  /** Model that actually answered (with failover, may differ step to step). */
  model?: string;
}

export interface ReasoningRecord {
  groupId: number;
  splitId?: string;
  trigger: AgentInput['trigger'];
  thoughts: Thought[];
  finalResponse: string;
}

function clip(value: unknown): unknown {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s === undefined) return value;
  if (s.length <= MAX_FIELD_CHARS) return typeof value === 'string' ? value : JSON.parse(s);
  return `${s.slice(0, MAX_FIELD_CHARS)}… [truncated ${s.length - MAX_FIELD_CHARS} chars]`;
}

/** Convert ai@7 step results into the compact shape we persist. */
export function summariseSteps(steps: ReadonlyArray<StepResult<ToolSet>>): Thought[] {
  return steps.map((s, i) => ({
    step: i + 1,
    reasoning: s.reasoningText ? (clip(s.reasoningText) as string) : undefined,
    text: s.text || undefined,
    toolCalls: s.toolCalls.map((c) => ({ tool: c.toolName, input: clip(c.input) })),
    toolResults: s.toolResults.map((r) => ({ tool: r.toolName, output: clip(r.output) })),
    toolErrors: s.content
      .filter((p) => p.type === 'tool-error')
      .map((p) => ({ tool: p.toolName, error: String(clip(p.error instanceof Error ? p.error.message : p.error)) })),
    tokens: { input: s.usage.inputTokens, output: s.usage.outputTokens },
    model: s.response?.modelId,
  }));
}
