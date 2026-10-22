import type { FastifyInstance } from 'fastify';
import { telegramStatus } from '../lib/telegram-status.js';

// Hit by UptimeRobot every 10 min to keep Render warm. Keep it cheap: no DB calls.
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  // ok stays true while Telegram is retrying: the process is healthy, and Render/UptimeRobot
  // restarting it wouldn't fix an unreachable Telegram. `telegram` shows the real state.
  app.get('/health', async () => ({
    ok: true,
    service: 'siren',
    uptimeSeconds: Math.round(process.uptime()),
    telegram: telegramStatus.state,
  }));
}
