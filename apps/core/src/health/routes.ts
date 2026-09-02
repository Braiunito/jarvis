import type { FastifyInstance } from 'fastify';
import type { CoreServices } from '../services.js';

export function registerHealthRoutes(app: FastifyInstance, services: CoreServices): void {
  app.get('/api/health', async (request, reply) => {
    const probeHosts = (request.query as { hosts?: string } | undefined)?.hosts !== 'skip';
    return reply.send(await services.health.snapshot({ probeHosts }));
  });
}
