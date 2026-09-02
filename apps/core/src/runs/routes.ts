import type { FastifyInstance } from 'fastify';
import { JarvisError, type CreateRunRequest } from '@jarvis/contracts';
import { identityOf } from '../app.js';
import type { CoreServices } from '../services.js';
import { streamRunEvents } from './sse.js';

export function registerRunRoutes(app: FastifyInstance, services: CoreServices): void {
  /**
   * Devuelve 202 con el `runId` antes de que empiece nada largo: el trabajo no cuelga de esta
   * petición, y por eso cerrar la pestaña no lo cancela.
   */
  app.post('/api/runs', async (request, reply) => {
    const body = (request.body ?? {}) as CreateRunRequest;
    const headerKey = request.headers['idempotency-key'];
    const created = await services.runs.create(
      {
        ...body,
        ...(body.idempotencyKey || typeof headerKey === 'string'
          ? { idempotencyKey: body.idempotencyKey ?? (headerKey as string) }
          : {}),
      },
      identityOf(request),
      String(request.id),
    );
    return reply.code(created.replayed ? 200 : 202).send(created);
  });

  app.get('/api/runs', async (request, reply) => {
    const limit = Number((request.query as { limit?: string } | undefined)?.limit ?? 50) || 50;
    return reply.send({ runs: services.runs.listRecent(limit) });
  });

  app.get('/api/runs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send({ run: services.runs.require(id) });
  });

  app.get('/api/runs/:id/events', async (request, reply) => {
    const { id } = request.params as { id: string };
    const afterSeq = Number((request.query as { afterSeq?: string } | undefined)?.afterSeq ?? -1);
    services.runs.require(id);
    return reply.send({ events: services.runs.events(id, Number.isFinite(afterSeq) ? afterSeq : -1) });
  });

  app.post('/api/runs/:id/cancel', async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send({ run: await services.runs.cancel(id, identityOf(request), String(request.id)) });
  });

  /**
   * Dar por visto lo que pedía atención.
   *
   * No cambia el trabajo ni su estado: sólo deja de reclamar en la navegación. Sin `:id` se dan
   * por vistos todos los que reclaman, que es lo que hace falta cuando la lista arrastra fallos de
   * hace días ya resueltos.
   */
  app.post('/api/runs/ack', async (request, reply) => {
    const user = identityOf(request);
    const changed = services.runRepository.acknowledge(user.username, services.clock.nowIso());
    return reply.send({ acknowledged: changed });
  });

  app.post('/api/runs/:id/ack', async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = identityOf(request);
    services.runs.require(id);
    const changed = services.runRepository.acknowledge(user.username, services.clock.nowIso(), id);
    return reply.send({ acknowledged: changed, run: services.runs.require(id) });
  });

  /** Reintentar crea otro run enlazado al anterior: el original no se rebobina jamás. */
  app.post('/api/runs/:id/retry', async (request, reply) => {
    const { id } = request.params as { id: string };
    const created = await services.runs.retry(id, identityOf(request), String(request.id));
    return reply.code(202).send(created);
  });

  /**
   * SSE. Se sirve sobre la respuesta cruda porque el stream lo gestiona el propio handler, y no
   * puede quedarse en ningún búfer intermedio.
   */
  app.get('/events/runs/:id', (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      services.runs.require(id);
    } catch (error) {
      throw error instanceof JarvisError ? error : new JarvisError('NOT_FOUND', 'unknown run');
    }
    reply.hijack();
    streamRunEvents(request, reply, services.runs, id);
  });
}
