import type { FastifyInstance } from 'fastify';
import { JarvisError, type Provider } from '@jarvis/contracts';
import type { CoreServices } from '../services.js';

export function registerUsageRoutes(app: FastifyInstance, services: CoreServices): void {
  /**
   * El uso se pide por workspace, no por host suelto: así el snapshot corresponde exactamente al
   * sitio donde ese trabajo se ejecutaría.
   */
  app.get('/api/usage', async (request, reply) => {
    const query = (request.query ?? {}) as {
      workspaceId?: string; provider?: Provider; host?: string; retryPartial?: string;
    };
    // Un sondeo que trajo la cuenta pero no las cuotas se puede reintentar saltándose el TTL.
    const retryPartial = query.retryPartial === '1' || query.retryPartial === 'true';
    if (query.workspaceId) {
      const workspace = services.workspaces.require(query.workspaceId);
      const target = await services.runs.planTarget(workspace, {});
      return reply.send(await services.usage.get({
        provider: workspace.ref.provider, executionHost: target.executionHost, retryPartial,
      }));
    }
    if (!query.provider || !query.host) {
      throw new JarvisError('BAD_REQUEST', 'workspaceId, or provider and host, are required');
    }
    return reply.send(await services.usage.get({
      provider: query.provider, executionHost: query.host, retryPartial,
    }));
  });
}
