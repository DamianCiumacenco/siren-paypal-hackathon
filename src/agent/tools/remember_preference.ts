import { tool } from 'ai';
import { z } from 'zod';
import type { MemoryStore } from '../../db/memory.js';
import type { AgentContext } from '../types.js';

export const MAX_NOTES_CHARS = 500;

/** Append a dated note, dropping the oldest lines so the column stays small (it's in every prompt). */
export function appendNote(existing: string | null, note: string, now: Date): string {
  const lines = [...(existing ? existing.split('\n') : []), `${now.toISOString().slice(0, 10)}: ${note.trim()}`];
  while (lines.length > 1 && lines.join('\n').length > MAX_NOTES_CHARS) lines.shift();
  return lines.join('\n').slice(-MAX_NOTES_CHARS);
}

/** remember_preference: persist a stated or inferred preference about a member of THIS group. */
export function createRememberPreferenceTool(deps: { context: AgentContext; store: MemoryStore; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());
  return tool({
    description:
      'Remember something about a member: their preferred reminder tone and/or a short factual note (e.g. "paid late, said payday is the 25th").',
    inputSchema: z
      .object({
        user_id: z.number().int().describe('user_id from the group context'),
        preferred_tone: z.enum(['chill', 'neutral', 'direct']).optional(),
        note: z.string().min(3).max(200).optional(),
      })
      .refine((v) => v.preferred_tone !== undefined || v.note !== undefined, 'give preferred_tone and/or note'),
    execute: async ({ user_id, preferred_tone, note }) => {
      const profile = await deps.store.getProfile(user_id, deps.context.groupId);
      if (!profile) return { ok: false, error: 'not a member of this group' };
      const notes = note ? appendNote(profile.notes, note, now()) : undefined;
      await deps.store.updatePreference(user_id, deps.context.groupId, { preferredTone: preferred_tone, notes });
      return { ok: true, name: profile.name, preferred_tone: preferred_tone ?? profile.preferredTone, notes: notes ?? profile.notes };
    },
  });
}
