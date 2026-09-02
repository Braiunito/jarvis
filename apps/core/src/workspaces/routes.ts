import type { FastifyInstance } from 'fastify';
import { JarvisError, type OpenWorkspaceRequest, type PutDraftRequest } from '@jarvis/contracts';
import { identityOf } from '../app.js';
import type { CoreServices } from '../services.js';

export function registerWorkspaceRoutes(app: FastifyInstance, services: CoreServices): void {
  /**
   * Abrir es idempotente: la misma sesión devuelve el mismo workspace, así que dos clics rápidos
   * no pueden dejar la interfaz partida entre dos contextos.
   */
  app.post('/api/workspaces', async (request, reply) => {
    const body = (request.body ?? {}) as OpenWorkspaceRequest;
    if (!body.ref?.host || !body.ref?.provider || !body.ref?.sessionId) {
      throw new JarvisError('BAD_REQUEST', 'a session ref (host, provider, sessionId) is required');
    }
    const { workspace, created } = services.workspaces.open(body, identityOf(request));
    return reply.code(created ? 201 : 200).send({ workspace, created });
  });

  app.get('/api/workspaces', async (request, reply) => {
    const limit = Number((request.query as { limit?: string } | undefined)?.limit ?? 20) || 20;
    return reply.send({ workspaces: services.workspaces.recent(limit) });
  });

  app.get('/api/workspaces/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const workspace = services.workspaces.require(id);
    return reply.send({
      workspace,
      draft: services.workspaces.draft(id, identityOf(request)),
      runs: services.runs.listByWorkspace(id, 20),
      attachments: services.attachments.listForWorkspace(id),
    });
  });

  /** El destino efectivo que el composer debe enseñar *antes* de Send. */
  app.get('/api/workspaces/:id/target', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = (request.query ?? {}) as { permissionProfile?: 'safe' | 'auto' | 'yolo'; strategy?: 'auto' | 'A' | 'B' };
    const workspace = services.workspaces.require(id);
    const target = await services.runs.planTarget(workspace, {
      ...(query.permissionProfile ? { permissionProfile: query.permissionProfile } : {}),
      ...(query.strategy ? { preferredStrategy: query.strategy } : {}),
    });
    return reply.send({ target });
  });

  /**
   * El título que escribe una persona. A partir de aquí, el automático no vuelve a tocarlo.
   */
  app.put('/api/workspaces/:id/title', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { title?: string };
    if (typeof body.title !== 'string' || !body.title.trim()) {
      throw new JarvisError('BAD_REQUEST', 'title es obligatorio');
    }
    services.workspaces.require(id);
    services.titles.setByUser(id, body.title.trim());
    return reply.send({ workspace: services.workspaces.require(id) });
  });

  app.get('/api/workspaces/:id/draft', async (request, reply) => {
    const { id } = request.params as { id: string };
    return reply.send(services.workspaces.draft(id, identityOf(request)));
  });

  /**
   * Compare-and-swap. Un 409 con la versión del servidor es mucho mejor que una escritura
   * perdida en silencio.
   */
  app.put('/api/workspaces/:id/draft', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as PutDraftRequest;
    if (typeof body.body !== 'string' || !Number.isInteger(body.expectedVersion)) {
      throw new JarvisError('BAD_REQUEST', 'body and expectedVersion are required');
    }
    return reply.send(services.workspaces.putDraft(id, identityOf(request), body.body, body.expectedVersion));
  });
}
