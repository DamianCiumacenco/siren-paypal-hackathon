import type { MemoryStore, Tone } from '../db/memory.js';
import { computeStats, type PaymentStats } from './scoring.js';
import { pickTone } from './tone.js';

export interface RecomputeResult {
  stats: PaymentStats;
  /** Tone written, or undefined if the member's tone is locked (set explicitly). */
  autoTone?: Tone;
}

/**
 * Recompute a member's memory for one group from their full payment record. Idempotent
 * (always recomputed from scratch, never incremented), so running it again after a
 * PayPal webhook retry, or from the scheduler, can't double-count.
 */
export async function recomputeMemory(
  store: MemoryStore,
  userId: number,
  groupId: number,
  now: Date = new Date(),
): Promise<RecomputeResult> {
  const stats = computeStats(await store.paymentRecord(userId, groupId), now);
  const locked = await store.isToneLocked(userId, groupId);
  const autoTone = locked ? undefined : pickTone(stats.reliabilityScore);
  await store.saveStats(userId, groupId, stats, autoTone);
  return { stats, autoTone };
}
