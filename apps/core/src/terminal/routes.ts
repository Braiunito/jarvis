import type { FastifyInstance } from 'fastify';
import { JarvisError, type OpenTerminalRequest } from '@jarvis/contracts';
import { identityOf } from '../app.js';
import type { CoreServices } from '../services.js';

export function registerTerminalRoutes(app: FastifyInstance, services: CoreServices): void {
  app.get('/api/terminal/sessions', async (request, reply) => {
    const host = (request.query as { host?: string } | undefined)?.host;
    if (!host) throw new JarvisError('BAD_REQUEST', 'host is required');
    return reply.send({ sessions: await services.terminal.list(host) });
  });

  app.post('/api/terminal/open', async (request, reply) => {
    const body = (request.body ?? {}) as OpenTerminalRequest;
    if (!body.host || !body.provider) throw new JarvisError('BAD_REQUEST', 'host and provider are required');
    const opened = await services.terminal.open({
      host: body.host,
      provider: body.provider,
      sessionId: body.sessionId ?? null,
      cwd: body.cwd ?? null,
      permissionProfile: body.permissionProfile ?? 'safe',
      user: identityOf(request),
    });
    return reply.send(opened);
  });

  app.get('/api/terminal/capture', async (request, reply) => {
    const query = (request.query ?? {}) as { host?: string; name?: string; lines?: string };
    if (!query.host || !query.name) throw new JarvisError('BAD_REQUEST', 'host and name are required');
    const text = await services.terminal.capture({
      host: query.host, name: query.name, ...(query.lines ? { lines: Number(query.lines) } : {}),
    });
    return reply.send({ text });
  });

  /** Destruir es explícito: salir de la terminal no mata nada. */
  app.post('/api/terminal/destroy', async (request, reply) => {
    const body = (request.body ?? {}) as { host?: string; name?: string };
    if (!body.host || !body.name) throw new JarvisError('BAD_REQUEST', 'host and name are required');
    await services.terminal.destroy({ host: body.host, name: body.name, user: identityOf(request) });
    return reply.send({ ok: true });
  });
}
