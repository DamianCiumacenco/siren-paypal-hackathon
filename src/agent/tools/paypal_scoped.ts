import { tool, type Tool, type ToolSet } from 'ai';
import { executeToolkit } from '../../paypal/toolkit.js';
import type { AgentContext } from '../types.js';
import { REMINDER_COOLDOWN_MS, type DmMember } from './telegram_dm.js';

/**
 * The PayPal toolkit acts on the whole merchant account: given any invoice id it will
 * remind/cancel/send it, whichever group it belongs to. In the milestone-5 live run the
 * agent found an unrelated invoice and reminded it on a guess. This wraps the toolkit's
 * invoice tools (the PayPal call itself is still the toolkit's) with Siren's guardrails:
 *
 * - invoice ids must belong to a split member in THIS group, or have been created
 *   earlier in this same agent run (create_invoice → send_invoice);
 * - send_invoice_reminder shares telegram_dm's 1-reminder-per-user-per-24h limit;
 * - every result is normalised to { ok: true, ... } / { ok: false, error } because the
 *   toolkit never throws on failure.
 */

export interface InvoiceScopeStore {
  /** Member whose paypal_invoice_id this is, if their split is in groupId. */
  getMemberByInvoice(invoiceId: string, groupId: number): Promise<DmMember | null>;
  lastReminderAt(userId: number): Promise<Date | null>;
  recordReminder(splitMemberId: string, remindersSent: number, at: Date): Promise<void>;
}

export interface ScopedPayPalDeps {
  context: AgentContext;
  store: InvoiceScopeStore;
  now?: () => Date;
}

type Result = Record<string, unknown> & { ok: boolean };

/** Run a toolkit tool and normalise its output (it returns errors as JSON, never throws). */
async function runToolkit(t: Tool, input: unknown): Promise<Result> {
  try {
    return { ...(await executeToolkit(t, input)), ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

type Money = { value?: string; currency_code?: string };
interface PayPalInvoice {
  id?: string;
  status?: string;
  amount?: Money;
  due_amount?: Money;
  payments?: { paid_amount?: Money };
  detail?: { metadata?: { recipient_view_url?: string } };
  primary_recipients?: { billing_info?: { email_address?: string } }[];
  links?: { rel?: string; href?: string }[];
}

const money = (m?: Money) => (m?.value ? `${m.value} ${m.currency_code ?? ''}`.trim() : undefined);

/**
 * A full PayPal invoice is several KB of JSON. Groq's free tier allows 8k tokens per
 * minute in total, and one oversized tool result made a single step exceed that. Give
 * the agent only the fields it acts on.
 */
export function summariseInvoice(result: Result): Result {
  if (!result.ok) return result;
  const inv = result as unknown as PayPalInvoice;
  return {
    ok: true,
    id: inv.id,
    status: inv.status,
    amount: money(inv.amount),
    due: money(inv.due_amount),
    paid: money(inv.payments?.paid_amount),
    payer_email: inv.primary_recipients?.[0]?.billing_info?.email_address,
    pay_link: inv.detail?.metadata?.recipient_view_url ?? inv.links?.find((l) => l.rel === 'payer-view')?.href,
  };
}

export function scopePayPalTools(paypal: ToolSet, deps: ScopedPayPalDeps): ToolSet {
  const now = deps.now ?? (() => new Date());
  const createdThisRun = new Set<string>();

  const wrap = (
    name: string,
    guard?: (input: { invoice_id: string }) => Promise<Result | null>,
    shape: (r: Result) => Result = (r) => r,
  ) => {
    const original = paypal[name];
    if (!original) return undefined;
    return tool({
      description: original.description,
      inputSchema: original.inputSchema as never,
      execute: async (input: { invoice_id: string }) => {
        if (guard) {
          const refusal = await guard(input);
          if (refusal) return refusal;
        }
        return shape(await runToolkit(original, input));
      },
    });
  };

  const inThisGroup = async ({ invoice_id }: { invoice_id: string }): Promise<Result | null> => {
    if (createdThisRun.has(invoice_id)) return null;
    const member = await deps.store.getMemberByInvoice(invoice_id, deps.context.groupId);
    return member
      ? null
      : {
          ok: false,
          error: `invoice ${invoice_id} is not part of any split in this group`,
          hint: 'Only use invoice ids shown in the group context or created in this run.',
        };
  };

  const scoped: ToolSet = {};

  if (paypal.create_invoice) {
    const create = paypal.create_invoice;
    scoped.create_invoice = tool({
      description: create.description,
      inputSchema: create.inputSchema as never,
      execute: async (input: unknown) => {
        const result = await runToolkit(create, input);
        // PayPal returns either the invoice or a link to it; remember the id either way.
        const href = typeof result.href === 'string' ? result.href : undefined;
        const id = typeof result.id === 'string' ? result.id : href?.split('/').pop();
        if (result.ok && id) {
          createdThisRun.add(id);
          return { ...result, invoice_id: id };
        }
        return result;
      },
    });
  }

  const getInvoice = wrap('get_invoice', inThisGroup, summariseInvoice);
  if (getInvoice) scoped.get_invoice = getInvoice;
  for (const name of ['send_invoice', 'cancel_sent_invoice']) {
    const wrapped = wrap(name, inThisGroup);
    if (wrapped) scoped[name] = wrapped;
  }

  const reminder = paypal.send_invoice_reminder;
  if (reminder) {
    scoped.send_invoice_reminder = tool({
      description: reminder.description,
      inputSchema: reminder.inputSchema as never,
      execute: async (input: { invoice_id: string }) => {
        const member = await deps.store.getMemberByInvoice(input.invoice_id, deps.context.groupId);
        if (!member) {
          return { ok: false, error: `invoice ${input.invoice_id} is not part of any split in this group` };
        }
        if (member.status === 'paid' || member.status === 'cancelled') {
          return { ok: false, error: `${member.displayName} is already ${member.status} — no reminder sent` };
        }
        // Members with no Telegram user have no user id to rate-limit by, so fall back to
        // this member's own last reminder — otherwise a 5-minute cron could email them
        // every pass.
        {
          const last =
            member.userId !== null
              ? await deps.store.lastReminderAt(member.userId)
              : member.lastRemindedAt
                ? new Date(member.lastRemindedAt)
                : null;
          if (last && now().getTime() - last.getTime() < REMINDER_COOLDOWN_MS) {
            return {
              ok: false,
              error: `rate limited: ${member.displayName} was reminded at ${last.toISOString()}`,
              hint: 'Max 1 reminder per user per 24h across Telegram and PayPal. Do not retry now.',
            };
          }
        }
        const result = await runToolkit(reminder, input);
        // Count it only once PayPal accepted it.
        if (result.ok) await deps.store.recordReminder(member.splitMemberId, member.remindersSent + 1, now());
        return result;
      },
    });
  }

  return scoped;
}
