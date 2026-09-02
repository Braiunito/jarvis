import type { FastifyInstance } from 'fastify';
import type { Provider } from '@jarvis/contracts';
import { JarvisError } from '@jarvis/contracts';
import type { CoreServices } from '../services.js';

interface SearchQuery {
  q?: string;
  host?: string;
  provider?: Provider;
  cwd?: string;
  limit?: string;
  since?: string;
}

export function registerSessionRoutes(app: FastifyInstance, services: CoreServices): void {
  app.get('/api/sessions', async (request, reply) => {
    const query = (request.query ?? {}) as SearchQuery;
    /**
     * Sin `limit` no se inventa uno aquí: lo decide el servicio, que es quien sabe cuántas caben
     * y quien marca la respuesta como recortada.
     *
     * Esta línea tenía un `?? 50` que pisaba ese acuerdo: la consola pedía sin límite, la ruta
     * mandaba 50 y veintitrés sesiones de la flota no aparecían nunca —ni ellas ni un aviso de que
     * faltaban—. Un tope por si acaso sigue habiendo, pero sólo para lo que alguien pida a mano.
     */
    const asked = Number(query.limit);
    const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 500) : undefined;
    const result = await services.sessions.search({
      q: query.q,
      host: query.host,
      provider: query.provider,
      cwd: query.cwd,
      since: query.since,
      ...(limit ? { limit } : {}),
    });
    return reply.send(result);
  });

  app.get('/api/sessions/transcript', async (request, reply) => {
    const query = (request.query ?? {}) as { host?: string; provider?: Provider; sessionId?: string; last?: string };
    if (!query.host || !query.provider || !query.sessionId) {
      throw new JarvisError('BAD_REQUEST', 'host, provider and sessionId are required');
    }
    const last = query.last ? Number(query.last) : undefined;
    const transcript = await services.sessions.transcript(
      { host: query.host, provider: query.provider, sessionId: query.sessionId },
      last ? { last } : {},
    );
    return reply.send(transcript);
  });

  app.get('/api/sessions/freshness', async (_request, reply) =>
    reply.send({ hosts: await services.sessions.freshness() }));
}
