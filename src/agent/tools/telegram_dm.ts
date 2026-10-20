import { GrammyError } from 'grammy';
import { tool } from 'ai';
import { z } from 'zod';
import type { AgentContext } from '../types.js';

export const REMINDER_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGE_CHARS = 1000; // Telegram allows 4096; keep agent DMs short.

export interface DmMember {
  splitMemberId: string;
  displayName: string;
  status: 'pending' | 'sent' | 'paid' | 'failed' | 'cancelled';
  remindersSent: number;
  userId: number | null;
  telegramUserId: number | null;
}

export interface DmStore {
  /** Returns null if the member doesn't exist OR belongs to a different group. */
  getMember(splitMemberId: string, groupId: number): Promise<DmMember | null>;
  /** Most recent reminder sent to this user across all their splits. */
  lastReminderAt(userId: number): Promise<Date | null>;
  recordReminder(splitMemberId: string, remindersSent: number, at: Date): Promise<void>;
  /** pending → sent once their payment link has been delivered. */
  markLinkSent(splitMemberId: string): Promise<void>;
}

export type SendDm = (telegramUserId: number, text: string) => Promise<void>;

export interface TelegramDmDeps {
  context: AgentContext;
  store: DmStore;
  sendDm: SendDm;
  now?: () => Date;
}

export const telegramDmInput = z.object({
  split_member_id: z.string().uuid().describe('split_member_id from the group context'),
  kind: z
    .enum(['payment_link', 'reminder'])
    .describe('payment_link = first delivery of their pay link; reminder = any nag or check-in (rate limited 1/24h)'),
  message: z.string().min(1).max(MAX_MESSAGE_CHARS).describe('The DM text, written in the member\'s preferred tone'),
});

type Result = { ok: true; sent_to: string; kind: string } | { ok: false; error: string; hint?: string };

/**
 * telegram_dm: send a private Telegram message to one member of an open split.
 * Guardrails live HERE, not just in the prompt (CLAUDE.md): group scoping, no DMs
 * to paid/cancelled members, and max 1 reminder per user per 24h.
 */
export function createTelegramDmTool(deps: TelegramDmDeps) {
  const now = deps.now ?? (() => new Date());

  return tool({
    description:
      'Send a private Telegram DM to one member of an open split in this group (e.g. their PayPal pay link, or a reminder). ' +
      'Reminders are limited to 1 per user per 24h and are refused for members who already paid.',
    inputSchema: telegramDmInput,
    execute: async ({ split_member_id, kind, message }): Promise<Result> => {
      const member = await deps.store.getMember(split_member_id, deps.context.groupId);
      if (!member) return { ok: false, error: 'split member not found in this group' };
      if (member.status === 'paid' || member.status === 'cancelled') {
        return { ok: false, error: `${member.displayName} is already ${member.status} — no DM sent` };
      }
      if (member.telegramUserId === null || member.userId === null) {
        return {
          ok: false,
          error: `${member.displayName} isn't linked to a Telegram account`,
          hint: 'Ask them to send /start to Siren in a private chat.',
        };
      }

      const at = now();
      if (kind === 'reminder') {
        const last = await deps.store.lastReminderAt(member.userId);
        if (last && at.getTime() - last.getTime() < REMINDER_COOLDOWN_MS) {
          const hoursLeft = Math.ceil((REMINDER_COOLDOWN_MS - (at.getTime() - last.getTime())) / 3_600_000);
          return {
            ok: false,
            error: `rate limited: ${member.displayName} was reminded at ${last.toISOString()}`,
            hint: `Next reminder allowed in ~${hoursLeft}h. Do not retry now.`,
          };
        }
      }

      try {
        await deps.sendDm(member.telegramUserId, message);
      } catch (err) {
        // 403 = user never opened a DM with the bot, or blocked it. Telegram bots can't
        // start conversations, so tell the agent how to fix it instead of failing the run.
        if (err instanceof GrammyError && err.error_code === 403) {
          return {
            ok: false,
            error: `Telegram won't let Siren DM ${member.displayName} (${err.description})`,
            hint: 'Ask them to open a private chat with Siren and press Start.',
          };
        }
        throw err;
      }

      if (kind === 'reminder') await deps.store.recordReminder(member.splitMemberId, member.remindersSent + 1, at);
      else await deps.store.markLinkSent(member.splitMemberId);
      return { ok: true, sent_to: member.displayName, kind };
    },
  });
}
