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
    const limit = Math.min(Math.max(Number(query.limit ?? 50) || 50, 1), 200);
    const result = await services.sessions.search({
      q: query.q,
      host: query.host,
      provider: query.provider,
      cwd: query.cwd,
      since: query.since,
      limit,
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
