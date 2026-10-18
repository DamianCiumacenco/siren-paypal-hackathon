import type { FastifyInstance } from 'fastify';

// Hit by UptimeRobot every 10 min to keep Render warm. Keep it cheap: no DB calls.
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({ ok: true, service: 'siren', uptimeSeconds: Math.round(process.uptime()) }));
}
