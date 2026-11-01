import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { buildDashboardData, type DashboardSources } from '../dashboard/data.js';
import { verifyDashboardToken } from '../dashboard/link.js';
import { logError } from '../lib/safe-error.js';

export interface DashboardRouteOptions {
  key: Buffer;
  sources: DashboardSources;
}

const PUBLIC_DIR = new URL('../../public/', import.meta.url);
// AG Grid Community, pinned (sponsor prize eligibility). Nothing else loads from outside.
const CDN = 'https://cdn.jsdelivr.net';
const HEADERS = {
  'content-security-policy':
    `default-src 'none'; script-src 'self' ${CDN}; style-src 'self' 'unsafe-inline' ${CDN}; ` +
    `connect-src 'self'; img-src 'self' data:; font-src ${CDN} data:; base-uri 'none'; frame-ancestors 'none'`,
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
};

/**
 * GET /dashboard          the page (static; the signed token is in the URL fragment)
 * GET /dashboard/app.js   its script, GET /dashboard/app.css its styles
 * GET /dashboard/api      one group's data; token in `x-dashboard-token` (src/dashboard/link.ts)
 * Read-only. 401 without a token, 403 for a bad or expired one.
 */
export async function dashboardRoutes(app: FastifyInstance, opts: DashboardRouteOptions): Promise<void> {
  const files = {
    html: readFileSync(new URL('dashboard.html', PUBLIC_DIR), 'utf8'),
    js: readFileSync(new URL('dashboard.js', PUBLIC_DIR), 'utf8'),
    css: readFileSync(new URL('dashboard.css', PUBLIC_DIR), 'utf8'),
  };

  app.get('/dashboard', async (_req, reply) => reply.headers(HEADERS).type('text/html; charset=utf-8').send(files.html));
  app.get('/dashboard/app.js', async (_req, reply) => reply.headers(HEADERS).type('text/javascript; charset=utf-8').send(files.js));
  app.get('/dashboard/app.css', async (_req, reply) => reply.headers(HEADERS).type('text/css; charset=utf-8').send(files.css));

  app.get('/dashboard/api', async (req, reply) => {
    reply.headers(HEADERS);
    const token = req.headers['x-dashboard-token'];
    if (typeof token !== 'string' || !token) return reply.code(401).send({ error: 'missing dashboard token' });
    const check = verifyDashboardToken(token, opts.key);
    if (!check.ok) {
      return reply.code(403).send({
        error: check.reason === 'expired' ? 'This link has expired. Send /siren dashboard in the group for a new one.' : 'Invalid dashboard link.',
      });
    }
    try {
      const data = await buildDashboardData(check.groupId, opts.sources);
      if (!data) return reply.code(404).send({ error: 'This group no longer exists.' });
      return { ...data, expiresAt: check.expiresAt.toISOString() };
    } catch (err) {
      logError(req.log, err, 'dashboard data failed', { groupId: check.groupId });
      return reply.code(500).send({ error: 'Could not load the dashboard. Try again in a minute.' });
    }
  });
}
