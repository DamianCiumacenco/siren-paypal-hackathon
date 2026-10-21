import { schedule, type ScheduledTask } from 'node-cron';
import type { AgentOutput } from '../agent/run.js';
import type { AgentInput } from '../agent/types.js';
import { REMINDER_COOLDOWN_MS } from '../agent/tools/telegram_dm.js';
import type { MemoryStore } from '../db/memory.js';
import type { SchedulerStore, SplitToCheck } from '../db/scheduler.js';
import type { ChatLock } from '../lib/chat-lock.js';
import { toGroupText } from '../lib/group-text.js';
import { logError, type Logger } from '../lib/safe-error.js';
import { AllProvidersExhaustedError } from '../llm/failover.js';
import { LongRateLimitError } from '../llm/rate-limit.js';
import { recomputeMemory } from '../memory/profile.js';

/**
 * The autonomous half of Siren (Flow C): on NAG_CRON_INTERVAL, look at every open split
 * and let the agent decide — remind (in each member's tone), check in, wait
 * (schedule_followup) or do nothing. Runs with trigger 'scheduled_run', so the decision
 * shows up in /siren why as a scheduled check, not a user request.
 *
 * The rules that matter (24h reminder cap, group isolation, paid members untouchable)
 * live in the tools, so they hold here exactly as for user messages. This file only
 * decides WHICH splits are worth an LLM call:
 * - skip if the agent scheduled a later follow-up (next_nag_at in the future)
 * - skip if every unpaid member was reminded in the last 24h (nothing it could do)
 * - skip if the group is busy with a user's request
 * That's what keeps a '*\/5 * * * *' demo schedule from draining the LLM quota.
 */

export interface SchedulerDeps {
  store: SchedulerStore;
  memory: MemoryStore;
  runAgent: (input: AgentInput) => Promise<AgentOutput>;
  postToGroup: (telegramChatId: number, text: string) => Promise<void>;
  lock: ChatLock;
  log: Logger;
  now?: () => Date;
  /** Only look at these groups (agent:live uses this to stay inside its throwaway group). */
  groupIds?: number[];
}

export type SkipReason = 'followup_scheduled' | 'all_recently_reminded' | 'nobody_unpaid' | 'group_busy';

export interface PassResult {
  checked: number;
  agentRuns: number;
  posted: number;
  skipped: Partial<Record<SkipReason, number>>;
  failed: number;
  /** Every LLM provider was out of quota; the rest of the pass was skipped. */
  stoppedForQuota: boolean;
}

/** Whether a split needs the agent this pass, or why not (no LLM call either way). */
export function skipReason(split: SplitToCheck, now: Date): SkipReason | undefined {
  if (split.unpaid.length === 0) return 'nobody_unpaid';
  if (split.nextNagAt && new Date(split.nextNagAt) > now) return 'followup_scheduled';
  const remindable = split.unpaid.some(
    (m) => !m.lastRemindedAt || now.getTime() - new Date(m.lastRemindedAt).getTime() >= REMINDER_COOLDOWN_MS,
  );
  return remindable ? undefined : 'all_recently_reminded';
}

export function scheduledPrompt(split: SplitToCheck, now: Date): string {
  const hours = Math.round((now.getTime() - new Date(split.createdAt).getTime()) / 3_600_000);
  const who = split.unpaid.map((m) => `${m.name} (${m.remindersSent} reminders so far)`).join(', ');
  return (
    `[internal] Scheduled check. Split "${split.description}" ` +
    `(${split.perPersonAmount.toFixed(2)} ${split.currency} each, split_id ${split.id}) was opened ${hours}h ago. ` +
    `Still unpaid: ${who}. Decide for each: remind them in their tone, check in, wait (schedule_followup), or do nothing.`
  );
}

/** Did the agent actually contact anyone? Only then is it worth telling the group. */
const SIDE_EFFECT_TOOLS = new Set(['telegram_dm', 'send_invoice_reminder']);
function actedOnSomeone(out: AgentOutput): boolean {
  return out.thoughts.some((t) =>
    t.toolResults.some((r) => SIDE_EFFECT_TOOLS.has(r.tool) && (r.output as { ok?: boolean } | undefined)?.ok === true),
  );
}

const isQuotaGone = (err: unknown) => err instanceof AllProvidersExhaustedError || err instanceof LongRateLimitError;

export async function runScheduledPass(deps: SchedulerDeps): Promise<PassResult> {
  const now = deps.now?.() ?? new Date();
  const result: PassResult = { checked: 0, agentRuns: 0, posted: 0, skipped: {}, failed: 0, stoppedForQuota: false };
  const skip = (r: SkipReason) => (result.skipped[r] = (result.skipped[r] ?? 0) + 1);

  for (const split of await deps.store.openSplits({ groupIds: deps.groupIds })) {
    result.checked++;

    // Overdue unpaid shares lower reliability ("decrementing on no-pay"); deterministic, no LLM.
    for (const m of split.unpaid) {
      if (m.userId === null) continue;
      await recomputeMemory(deps.memory, m.userId, split.groupId, now).catch((err) =>
        logError(deps.log, err, 'scheduled memory recompute failed', { splitId: split.id }),
      );
    }

    const reason = skipReason(split, now);
    if (reason) {
      skip(reason);
      continue;
    }
    if (!deps.lock.tryAcquire(split.telegramChatId)) {
      skip('group_busy');
      continue;
    }
    try {
      result.agentRuns++;
      const out = await deps.runAgent({
        trigger: 'scheduled_run',
        userMessage: scheduledPrompt(split, now),
        context: { groupId: split.groupId, chatId: split.telegramChatId, splitId: split.id },
      });
      // Quiet decisions (wait / do nothing) stay in reasoning_log — /siren why shows them.
      // Posting them every pass would spam the group, especially on a 5-minute demo cron.
      if (actedOnSomeone(out)) {
        await deps.postToGroup(split.telegramChatId, toGroupText(out.response));
        result.posted++;
      }
    } catch (err) {
      if (isQuotaGone(err)) {
        // Don't post errors into groups for a background job; just stop and try next pass.
        deps.log.warn({ splitId: split.id }, 'scheduled pass stopped: LLM quota exhausted on all providers');
        result.stoppedForQuota = true;
        break;
      }
      result.failed++;
      logError(deps.log, err, 'scheduled agent run failed', { splitId: split.id, groupId: split.groupId });
    } finally {
      deps.lock.release(split.telegramChatId);
    }
  }

  deps.log.info({ ...result }, 'scheduled pass finished');
  return result;
}

/** Start the cron. noOverlap: a slow pass (LLM waits) is never run twice concurrently. */
export function startScheduler(cronExpr: string, pass: () => Promise<unknown>, log: Logger): ScheduledTask {
  const task = schedule(
    cronExpr,
    async () => {
      try {
        await pass();
      } catch (err) {
        logError(log, err, 'scheduled pass crashed');
      }
    },
    { name: 'siren-nag', noOverlap: true },
  );
  log.info({ cron: cronExpr, nextRun: task.getNextRun()?.toISOString() }, 'autonomous scheduler started');
  return task;
}
