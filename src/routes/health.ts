import type { FastifyInstance } from 'fastify';
import { safeErrorMessage } from '../lib/safe-error.js';
import { telegramStatus } from '../lib/telegram-status.js';

export interface HealthRouteOptions {
  /** Cheap round trip to Supabase. Omitted in tests that don't wire a database. */
  dbPing?: () => Promise<void>;
}

const DB_PING_TIMEOUT_MS = 5_000;

// Hit by UptimeRobot every 5 min (keeps Render's free instance awake) and by Render's
// health check. The DB ping is what makes a broken database visible: in milestone 13 the
// bot went silent on DB errors while /health stayed green. A failed ping answers 503, so
// UptimeRobot alerts. ok stays true while Telegram is retrying: restarting wouldn't fix an
// unreachable Telegram, and `telegram` shows the real state.
export async function healthRoutes(app: FastifyInstance, opts: HealthRouteOptions = {}): Promise<void> {
  app.get('/health', async (req, reply) => {
    let db: 'ok' | 'error' | 'not_checked' = 'not_checked';
    if (opts.dbPing) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          opts.dbPing(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`timed out after ${DB_PING_TIMEOUT_MS}ms`)), DB_PING_TIMEOUT_MS);
          }),
        ]);
        db = 'ok';
      } catch (err) {
        db = 'error';
        req.log.error({ reason: safeErrorMessage(err) }, 'health: database ping failed');
      } finally {
        clearTimeout(timer);
      }
    }
    if (db === 'error') reply.code(503);
    return {
      ok: db !== 'error',
      service: 'siren',
      uptimeSeconds: Math.round(process.uptime()),
      telegram: telegramStatus.state,
      db,
    };
  });
}
