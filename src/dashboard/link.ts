import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Per-group dashboard links (milestone 15). `/siren dashboard` in a group DMs the
 * requester a link that opens THAT group's dashboard only, for DASHBOARD_LINK_TTL_MS.
 *
 * Token = `<groupId>.<expiresUnix>.<hmac>`, HMAC-SHA256 over `<groupId>.<expiresUnix>`
 * with a key derived from the bot token (no extra env var; rotating the bot token
 * invalidates every link). It travels in the URL FRAGMENT (`/dashboard#t=…`): browsers
 * never send the fragment to the server, so it can't end up in request logs. The page
 * reads it and sends it to /dashboard/api in a header.
 */

export const DASHBOARD_LINK_TTL_MS = 24 * 3_600_000;

export function dashboardKey(botToken: string): Buffer {
  return createHash('sha256').update(`siren-dashboard:${botToken}`).digest();
}

const mac = (key: Buffer, payload: string) => createHmac('sha256', key).update(payload).digest('hex');

export function signDashboardToken(groupId: number, key: Buffer, now = Date.now()): string {
  const exp = Math.floor((now + DASHBOARD_LINK_TTL_MS) / 1000);
  return `${groupId}.${exp}.${mac(key, `${groupId}.${exp}`)}`;
}

export function dashboardUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/dashboard#t=${token}`;
}

export type TokenCheck = { ok: true; groupId: number; expiresAt: Date } | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

export function verifyDashboardToken(token: string, key: Buffer, now = Date.now()): TokenCheck {
  const m = /^(\d{1,18})\.(\d{1,12})\.([0-9a-f]{64})$/.exec(token);
  if (!m) return { ok: false, reason: 'malformed' };
  const [, g, exp, sig] = m as unknown as [string, string, string, string];
  const expected = Buffer.from(mac(key, `${g}.${exp}`), 'hex');
  if (!timingSafeEqual(expected, Buffer.from(sig, 'hex'))) return { ok: false, reason: 'bad_signature' };
  if (Number(exp) * 1000 <= now) return { ok: false, reason: 'expired' };
  return { ok: true, groupId: Number(g), expiresAt: new Date(Number(exp) * 1000) };
}
