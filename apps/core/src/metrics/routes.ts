import type { FastifyInstance } from 'fastify';
import type { CoreServices } from '../services.js';

export function registerMetricsRoutes(app: FastifyInstance, services: CoreServices): void {
  /**
   * Los agregados que pinta el panel. Se calculan aquí porque el navegador sólo ve una página de
   * runs y con eso no se puede afirmar una tendencia.
   */
  app.get('/api/metrics', async (request, reply) => {
    const query = (request.query ?? {}) as { hours?: string; buckets?: string };
    const hours = Math.min(Math.max(Number(query.hours ?? 24) || 24, 1), 24 * 30);
    const buckets = Math.min(Math.max(Number(query.buckets ?? 24) || 24, 4), 96);
    return reply.send(services.metrics.snapshot({ hours, buckets }));
  });
}
