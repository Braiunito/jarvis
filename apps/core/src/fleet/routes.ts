import type { FastifyInstance } from 'fastify';
import type { CoreServices } from '../services.js';

export function registerFleetRoutes(app: FastifyInstance, services: CoreServices): void {
  app.get('/api/hosts', async (request, reply) => {
    const force = (request.query as { force?: string } | undefined)?.force === '1';
    const hosts = await services.fleet.list({ force });
    return reply.send({ hosts, bastionHost: services.fleet.bastionHost });
  });
}
