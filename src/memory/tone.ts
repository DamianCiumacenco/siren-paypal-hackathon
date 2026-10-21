import type { Tone } from '../db/memory.js';

/**
 * Auto reminder tone from reliability (ARCHITECTURE.md):
 *   > 0.8 → chill,  0.4–0.8 → neutral,  < 0.4 → direct.  No history → neutral.
 * A tone set explicitly (/siren tone, or remember_preference) is locked and never
 * overwritten by this — see user_memory.tone_locked.
 */
export function pickTone(reliability: number | null): Tone {
  if (reliability === null) return 'neutral';
  if (reliability > 0.8) return 'chill';
  if (reliability >= 0.4) return 'neutral';
  return 'direct';
}
