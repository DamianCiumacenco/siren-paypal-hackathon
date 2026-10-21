import type { ToolSet } from 'ai';
import { GrammyError } from 'grammy';
import type { SendDm } from '../agent/tools/telegram_dm.js';
import type { SplitForSending, SplitStore } from '../db/splits.js';
import { logError, type Logger } from '../lib/safe-error.js';
import { executeToolkit } from './toolkit.js';

export interface SplitSendResult {
  /** Got their pay link by DM. */
  dmed: string[];
  /** Invoice created but couldn't DM them — post the link in the group instead. */
  linkInGroup: { name: string; link: string }[];
  /** PayPal failed for these; nothing was sent. */
  failed: string[];
}

export interface SplitSendDeps {
  /** Raw toolkit tools (create_invoice, send_invoice). Called directly, not by the LLM. */
  paypal: ToolSet;
  store: SplitStore;
  sendDm: SendDm;
  log: Logger;
}

/**
 * Runs after the creator taps ✅ (deterministic — no LLM in the money path):
 * per member, create + send a PayPal invoice through the toolkit, store the invoice id
 * and pay link, then DM the link. Members are processed one at a time so a PayPal
 * failure for one person doesn't affect the others.
 */
export async function sendSplitInvoices(split: SplitForSending, deps: SplitSendDeps): Promise<SplitSendResult> {
  const result: SplitSendResult = { dmed: [], linkInGroup: [], failed: [] };
  const amount = { currency_code: split.currency, value: split.perPersonAmount.toFixed(2) };

  for (const m of split.members) {
    let link: string;
    try {
      const created = await executeToolkit<{ id?: string; href?: string }>(deps.paypal.create_invoice!, {
        currency_code: split.currency,
        note: `Your share of "${split.description}" — sent by Siren`,
        // Name-only recipients are fine: the payer link is delivered by Telegram, not email.
        primary_recipients: [
          { billing_info: m.paypalEmail ? { email_address: m.paypalEmail } : { name: { given_name: m.displayName } } },
        ],
        items: [{ name: split.description, quantity: '1', unit_amount: amount }],
      });
      const invoiceId = created.id ?? created.href?.split('/').pop();
      if (!invoiceId) throw new Error('create_invoice returned no invoice id');
      // send_to_recipient:false → PayPal doesn't email; the response carries the payer-view link.
      const sent = await executeToolkit<{ href?: string }>(deps.paypal.send_invoice!, {
        invoice_id: invoiceId,
        send_to_recipient: false,
      });
      if (!sent.href) throw new Error(`send_invoice returned no payer link for ${invoiceId}`);
      link = sent.href;
      await deps.store.setMemberInvoice(m.id, invoiceId, link);
    } catch (err) {
      logError(deps.log, err, 'split invoice failed', { splitId: split.id, memberId: m.id });
      await deps.store.setMemberStatus(m.id, 'failed').catch(() => {});
      result.failed.push(m.displayName);
      continue;
    }

    if (m.telegramUserId === null) {
      result.linkInGroup.push({ name: m.displayName, link });
      continue;
    }
    try {
      await deps.sendDm(
        m.telegramUserId,
        `Hi ${m.displayName}, your share of "${split.description}" is ${amount.value} ${amount.currency_code}.\nPay with PayPal here: ${link}`,
      );
      await deps.store.setMemberStatus(m.id, 'sent');
      result.dmed.push(m.displayName);
    } catch (err) {
      // 403 = they never pressed Start on the bot / blocked it. Fall back to the group.
      if (!(err instanceof GrammyError && err.error_code === 403)) {
        logError(deps.log, err, 'split DM failed', { splitId: split.id, memberId: m.id });
      }
      result.linkInGroup.push({ name: m.displayName, link });
    }
  }
  return result;
}

/** Group message summarising the send. Neutral English (no reminder voice here). */
export function formatSendSummary(description: string, r: SplitSendResult): string {
  const lines: string[] = [];
  const total = r.dmed.length + r.linkInGroup.length;
  lines.push(total > 0 ? `PayPal requests for "${description}" are out (${total}).` : `No PayPal requests went out for "${description}".`);
  if (r.dmed.length) lines.push(`Sent by DM to: ${r.dmed.join(', ')}.`);
  if (r.linkInGroup.length) {
    lines.push('', "Couldn't DM these people (they need to open a private chat with me and press Start), so here are their links:");
    for (const l of r.linkInGroup) lines.push(`• ${l.name}: ${l.link}`);
  }
  if (r.failed.length) lines.push('', `PayPal failed for: ${r.failed.join(', ')}. Try /split again for them.`);
  lines.push('', 'Use /status any time to see who has paid.');
  return lines.join('\n');
}
