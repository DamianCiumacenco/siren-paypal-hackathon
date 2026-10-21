/**
 * Reliability score (ARCHITECTURE.md "Memory logic"):
 *   reliability   = 0.6 * on_time_ratio + 0.4 * speed_score
 *   on_time_ratio = paid_within_72h / total_splits
 *   speed_score   = clamp(1 - avg_hours_to_pay / 168, 0, 1)
 *
 * Which shares count ("total_splits"): only RESOLVED ones — paid, or unpaid and already
 * past the 72h window (so they count as late). A share that's still inside its 72h window
 * hasn't had a chance to be late yet, so it doesn't count either way.
 * Hours are measured from the split's creation (≈ when the requests went out).
 */
export const ON_TIME_HOURS = 72;
const WEEK_HOURS = 168;

export interface Share {
  createdAt: string;
  paidAt: string | null;
  /** split_members.status */
  status: string;
}

export interface PaymentStats {
  totalSplits: number;
  totalPaidOnTime: number;
  /** null until they've paid at least once */
  avgHoursToPay: number | null;
  /** null until there's at least one resolved share */
  reliabilityScore: number | null;
}

const hoursBetween = (from: string, to: string | Date) =>
  (new Date(to).getTime() - new Date(from).getTime()) / 3_600_000;

export function computeStats(shares: Share[], now: Date): PaymentStats {
  let total = 0;
  let onTime = 0;
  const paidHours: number[] = [];

  for (const s of shares) {
    if (s.status === 'cancelled') continue;
    if (s.status === 'paid' && s.paidAt) {
      const h = Math.max(0, hoursBetween(s.createdAt, s.paidAt));
      total++;
      paidHours.push(h);
      if (h <= ON_TIME_HOURS) onTime++;
    } else if (hoursBetween(s.createdAt, now) > ON_TIME_HOURS) {
      total++; // unpaid and overdue: counts as not on time
    }
  }

  if (total === 0) return { totalSplits: 0, totalPaidOnTime: 0, avgHoursToPay: null, reliabilityScore: null };
  const avg = paidHours.length ? paidHours.reduce((a, b) => a + b, 0) / paidHours.length : null;
  // Never paid but has overdue shares → slowest possible speed.
  const speed = avg === null ? 0 : Math.min(1, Math.max(0, 1 - avg / WEEK_HOURS));
  const reliability = 0.6 * (onTime / total) + 0.4 * speed;
  return {
    totalSplits: total,
    totalPaidOnTime: onTime,
    avgHoursToPay: avg === null ? null : Math.round(avg * 10) / 10,
    reliabilityScore: Math.round(reliability * 1000) / 1000,
  };
}
