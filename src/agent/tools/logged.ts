import type { ToolSet } from 'ai';
import { logError, type Logger } from '../../lib/safe-error.js';

/** What a tool call ended as. Logged instead of the result, which carries names and amounts. */
export type ToolOutcome = 'ok' | 'refused' | 'rate_limited';

export function toolOutcome(output: unknown): ToolOutcome {
  const r = output as { ok?: unknown; error?: unknown } | undefined;
  if (r?.ok !== false) return 'ok';
  return typeof r.error === 'string' && r.error.startsWith('rate limited') ? 'rate_limited' : 'refused';
}

/**
 * One structured log line per tool call: `agent tool call {tool, outcome, ms, groupId, splitId}`.
 * A tool that throws is logged via logError (safe message only) and the error is rethrown,
 * so the AI SDK still hands it back to the model as a tool error. Inputs and results are
 * never logged: they hold DM wording, names and amounts (the reasoning log keeps those).
 */
export function withToolLogging(tools: ToolSet, log: Logger, ids: { groupId: number; splitId?: string }): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, t]) => {
      const execute = t.execute;
      if (!execute) return [name, t];
      return [
        name,
        {
          ...t,
          execute: async (input: unknown, options: unknown) => {
            const started = Date.now();
            try {
              const output = await (execute as (i: unknown, o: unknown) => Promise<unknown>)(input, options);
              log.info({ tool: name, outcome: toolOutcome(output), ms: Date.now() - started, ...ids }, 'agent tool call');
              return output;
            } catch (err) {
              logError(log, err, 'agent tool failed', { tool: name, ms: Date.now() - started, ...ids });
              throw err;
            }
          },
        },
      ];
    }),
  ) as ToolSet;
}
