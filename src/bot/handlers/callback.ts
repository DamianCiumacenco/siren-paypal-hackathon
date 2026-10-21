import type { SplitForSending, SplitStore } from '../../db/splits.js';
import { logError, type Logger } from '../../lib/safe-error.js';
import { formatSendSummary, type SplitSendResult } from '../../paypal/split_invoices.js';
import type { SirenContext } from '../context.js';

export interface CallbackDeps {
  splits: SplitStore;
  sendSplit: (split: SplitForSending) => Promise<SplitSendResult>;
  log: Logger;
  background?: (work: Promise<void>) => void;
}

export const SPLIT_CALLBACK = /^split:(confirm|cancel):([0-9a-f-]{36})$/;

/** ✅ / ❌ taps on a split confirmation card. */
export function createSplitCallbackHandler(deps: CallbackDeps) {
  const background = deps.background ?? ((p) => void p);

  return async (ctx: SirenContext): Promise<void> => {
    const match = SPLIT_CALLBACK.exec(ctx.callbackQuery?.data ?? '');
    if (!match || !ctx.from) return;
    const [, action, splitId] = match as unknown as [string, 'confirm' | 'cancel', string];
    const originalText = ctx.callbackQuery?.message && 'text' in ctx.callbackQuery.message ? ctx.callbackQuery.message.text : '';

    if (action === 'cancel') {
      const cancelled = await deps.splits.cancelDraft(splitId, ctx.from.id);
      if (!cancelled) {
        await ctx.answerCallbackQuery({ text: 'Only the person who started this split can cancel it.', show_alert: true });
        return;
      }
      await ctx.answerCallbackQuery({ text: 'Cancelled' });
      await ctx.editMessageText(`${originalText}\n\n❌ Cancelled — nothing was sent.`).catch(() => {});
      return;
    }

    // Atomic draft → open: a double tap or a second person gets null here.
    const split = await deps.splits.confirmDraft(splitId, ctx.from.id);
    if (!split) {
      await ctx.answerCallbackQuery({
        text: 'Only the person who started this split can send it (or it was already sent/cancelled).',
        show_alert: true,
      });
      return;
    }
    await ctx.answerCallbackQuery({ text: 'Sending PayPal requests…' });
    await ctx.editMessageText(`${originalText}\n\n✅ Confirmed — sending PayPal requests…`).catch(() => {});

    background(
      (async () => {
        try {
          const result = await deps.sendSplit(split);
          await ctx.reply(formatSendSummary(split.description, result));
        } catch (err) {
          logError(deps.log, err, 'split send failed', { splitId, chatId: ctx.chat?.id });
          await ctx.reply('Something went wrong sending the PayPal requests. Check /status before trying again.').catch(() => {});
        }
      })(),
    );
  };
}
