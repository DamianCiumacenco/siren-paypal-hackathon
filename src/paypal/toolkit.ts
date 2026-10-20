import { PayPalAgentToolkit } from '@paypal/agent-toolkit/ai-sdk';
import { tool, type ToolSet } from 'ai';
import type { Config } from '../config.js';

/**
 * Which PayPal toolkit actions Siren's agent may use. Anything not listed here
 * is never handed to the LLM. Deliberately excluded:
 * - invoices.list: lists the WHOLE merchant account across every group, so the agent
 *   could find (and act on) another group's invoices. Seen in the milestone-5 live run.
 * - orders.*: splits are invoices only; orders are USD-only in the toolkit anyway.
 * - refunds, subscriptions, disputes: out of scope.
 */
export const PAYPAL_ACTIONS = {
  invoices: { create: true, send: true, get: true, sendReminder: true, cancel: true },
};

/** Tool names the toolkit exposes for PAYPAL_ACTIONS (asserted in tests). */
export const PAYPAL_TOOL_NAMES = [
  'create_invoice',
  'get_invoice',
  'send_invoice',
  'send_invoice_reminder',
  'cancel_sent_invoice',
] as const;

export type PayPalToolName = (typeof PAYPAL_TOOL_NAMES)[number];

/** Shape of a tool as produced by @paypal/agent-toolkit (built against ai@4). */
interface ToolkitV4Tool {
  description?: string;
  parameters: unknown; // zod 3 schema
  execute: (args: unknown, options?: unknown) => Promise<string>;
}

export function createPayPalToolkit(config: Pick<Config, 'PAYPAL_CLIENT_ID' | 'PAYPAL_CLIENT_SECRET'>) {
  return new PayPalAgentToolkit({
    clientId: config.PAYPAL_CLIENT_ID,
    clientSecret: config.PAYPAL_CLIENT_SECRET,
    configuration: {
      actions: PAYPAL_ACTIONS,
      context: { sandbox: true }, // sandbox only — see SCOPE.md hard limits
    },
  });
}

/**
 * The toolkit bundles its own ai@4 and returns v4-style tools `{ description, parameters, execute }`.
 * ai@7 (what Siren's agent runs on) wants `inputSchema` instead of `parameters`. ai@7 reads zod 3
 * schemas natively, so re-wrapping each tool is all that's needed. The PayPal call itself is
 * still the toolkit's own `execute` — nothing hand-rolled.
 */
export function adaptToolkitTools(v4Tools: Record<string, unknown>): ToolSet {
  const adapted: ToolSet = {};
  for (const [name, raw] of Object.entries(v4Tools)) {
    const t = raw as ToolkitV4Tool;
    adapted[name] = tool({
      description: t.description,
      inputSchema: t.parameters as never,
      execute: (args: unknown) => t.execute(args),
    });
  }
  return adapted;
}

/** PayPal tools ready to merge into the agent's tool set (milestone 5). */
export function getPayPalTools(config: Pick<Config, 'PAYPAL_CLIENT_ID' | 'PAYPAL_CLIENT_SECRET'>): ToolSet {
  return adaptToolkitTools(createPayPalToolkit(config).getTools());
}

/**
 * Toolkit tools return a JSON string. On failure they do NOT throw — they return either
 * `{"error": {...}}` (client-side errors) or `{"ok": false, "status": 403, "code", "message"}`
 * (PayPal HTTP errors) — so callers must check. This parses and throws on either.
 * Some PayPal calls (e.g. send_invoice_reminder) succeed with an empty 204 body, which the
 * toolkit returns as `""` — that becomes `{}`.
 */
export function parseToolkitResult<T = Record<string, unknown>>(result: unknown): T {
  if (result === '' || result === '""') return {} as T;
  const parsed = (typeof result === 'string' ? JSON.parse(result) : result) as Record<string, unknown>;
  if (parsed && typeof parsed === 'object') {
    if ('error' in parsed) throw new Error(`PayPal toolkit error: ${JSON.stringify(parsed.error)}`);
    if (parsed.ok === false) {
      throw new Error(`PayPal API error ${parsed.status} ${parsed.code}: ${parsed.message}`);
    }
  }
  return parsed as T;
}
