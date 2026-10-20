// Scripted LLM for agent tests: each entry is one model response (= one agent step).
import { MockLanguageModelV4 } from 'ai/test';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 5, text: 5, reasoning: 0 },
};

let callCounter = 0;

export function toolCallStep(toolName: string, input: Record<string, unknown>, reasoning?: string) {
  return {
    content: [
      ...(reasoning ? [{ type: 'reasoning' as const, text: reasoning }] : []),
      { type: 'tool-call' as const, toolCallId: `call-${++callCounter}`, toolName, input: JSON.stringify(input) },
    ],
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    usage,
    warnings: [],
  };
}

export function textStep(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage,
    warnings: [],
  };
}

export function scriptedModel(steps: ReturnType<typeof toolCallStep | typeof textStep>[]) {
  return new MockLanguageModelV4({ doGenerate: steps });
}
