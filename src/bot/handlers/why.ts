import type { Thought } from '../../agent/reasoning-log.js';
import type { ReasoningLogEntry } from '../../db/reasoning_log.js';
import type { SirenContext } from '../context.js';

/**
 * `/siren why` — show the agent's last decision straight from reasoning_log. No LLM: the
 * point (success criterion 5) is that the reasoning shown is what actually happened,
 * not a re-narration.
 *
 * It's posted in the GROUP, and the log holds private things (reminder wording, pay
 * links, internal ids), so everything is redacted and DM/note text is never shown.
 */

const MAX_CHARS = 3500; // Telegram's limit is 4096
const HIDDEN_INPUTS = new Set(['message', 'note', 'reason', 'split_member_id', 'user_id', 'split_id', 'invoice_id']);
const ID_KEYS = /(^|_)(id|ids)$|link|url|href/;

export function redact(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, '[link]')
    .replace(/\bINV2-[A-Z0-9-]+/g, '[invoice]')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[id]')
    .replace(/\[?\b(split_member_id|user_id|split_id)\s*[:=]?\s*(\[id\]|[\w-]+)\]?/gi, '[id]');
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function scalarPairs(obj: unknown, skip: (k: string) => boolean, max: number): string {
  if (!obj || typeof obj !== 'object') return typeof obj === 'string' ? clip(redact(obj), 80) : '';
  return Object.entries(obj as Record<string, unknown>)
    .filter(([k, v]) => !skip(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'))
    .slice(0, max)
    .map(([k, v]) => `${k}: ${clip(redact(String(v)), 40)}`)
    .join(', ');
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-IE', { day: 'numeric', month: 'short', timeZone: 'UTC' })} ${d.toISOString().slice(11, 16)} UTC`;
}

const TRIGGER_LABEL: Record<string, string> = {
  user_message: 'replying to a message',
  scheduled_run: 'scheduled check',
  webhook: 'after a payment',
};

export function formatWhy(entry: ReasoningLogEntry | null): string {
  if (!entry) return "I haven't made any decisions in this group yet.";
  const thoughts = (Array.isArray(entry.thoughts) ? entry.thoughts : []) as Thought[];
  const lines = [`My last decision (${TRIGGER_LABEL[entry.trigger ?? ''] ?? entry.trigger ?? 'unknown'}, ${formatTime(entry.createdAt)})`];

  for (const t of thoughts) {
    lines.push('', `Step ${t.step}${t.model ? ` (${t.model})` : ''}`);
    if (t.reasoning) lines.push(`thought: ${clip(redact(t.reasoning.replace(/\s+/g, ' ')), 280)}`);
    t.toolCalls.forEach((c, i) => {
      const args = scalarPairs(c.input, (k) => HIDDEN_INPUTS.has(k), 4);
      lines.push(`→ ${c.tool}${args ? ` (${args})` : ''}`);
      const r = t.toolResults[i]?.output as Record<string, unknown> | undefined;
      if (r) {
        const ok = r.ok === false ? '✗' : '✓';
        const detail = r.ok === false ? clip(redact(String(r.error ?? 'failed')), 120) : scalarPairs(r, (k) => k === 'ok' || ID_KEYS.test(k) || k === 'next_step', 3);
        lines.push(`← ${ok}${detail ? ` ${detail}` : ''}`);
      }
    });
    for (const e of t.toolErrors ?? []) lines.push(`✗ ${e.tool} failed: ${clip(redact(e.error), 120)}`);
  }
  if (entry.finalResponse) lines.push('', `Result: ${clip(redact(entry.finalResponse.replace(/\s+/g, ' ')), 300)}`);
  const text = lines.join('\n');
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS - 20)}\n… (truncated)` : text;
}

/** True for "/siren why" (optionally /siren@thisbot why). */
export function isWhyCommand(ctx: SirenContext): boolean {
  const m = /^\/siren(?:@(\w+))?\s+why\b/i.exec(ctx.message?.text?.trim() ?? '');
  return Boolean(m && (!m[1] || m[1].toLowerCase() === ctx.me.username.toLowerCase()));
}
