import type { FastifyInstance } from 'fastify';
import {
  JarvisError, type OpenWorkspaceRequest, type PutDraftRequest, type Workspace,
} from '@jarvis/contracts';
import { identityOf } from '../app.js';
import type { CoreServices } from '../services.js';

/**
 * Nombrar el workspace mientras la persona lo abre.
 *
 * Va en segundo plano a propósito: la pantalla no puede esperar a un modelo para pintarse, y el
 * nombre no es información crítica. La respuesta dice `titlePending` para que la interfaz vuelva a
 * preguntar en unos segundos en vez de quedarse con el hash.
 *
 * El material sale del transcript de la sesión —lo que la persona escribió en la máquina, con CLI
 * o sin ella— y, si el índice no responde, de los prompts de los trabajos lanzados desde aquí.
 */
async function nameInBackground(services: CoreServices, workspace: Workspace): Promise<void> {
  const runs = services.runs.listByWorkspace(workspace.id, 20);
  const userMessages: string[] = [];
  try {
    const transcript = await services.sessions.transcript(workspace.ref, { last: 20 });

    /*
     * El primer mensaje de la sesión sale del índice, no de la ventana.
     *
     * Se piden los últimos 20 mensajes —traer una sesión entera para ponerle nombre es caro— y
     * durante un rato se trató el primero de esa ventana como «el primer mensaje». En una sesión
     * larga eso es un mensaje cualquiera de la mitad, y de ahí salían títulos como «Bien, esa
     * campanita debería ir en el». El índice ya guarda el primer turno aprovechable de la sesión.
     */
    if (transcript.preview) userMessages.push(transcript.preview);

    // Y de la ventana sólo lo que escribió una persona: un `/model` tecleado en la CLI llega con
    // `role: "user"` y titulaba la sesión como «/model model».
    for (const message of transcript.messages) {
      if (message.role === 'user' && message.kind === 'text') userMessages.push(message.text);
    }
  } catch {
    // El índice puede estar caído: se nombra con lo que haya en casa antes que no nombrar.
  }
  if (userMessages.length === 0) {
    userMessages.push(...[...runs].reverse().map((run) => run.promptPreview ?? '').filter(Boolean));
  }
  const lastResult = runs.find((run) => run.resultSummary)?.resultSummary ?? null;
  await services.titles.nameOnOpen(workspace.id, { userMessages, lastResult });
}

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

    // Entrar en un workspace es el momento de arreglarle el nombre si lo tiene mal: es cuando hay
    // más contexto y cuando alguien lo está mirando. Ni bloquea la respuesta ni se repite.
    const titlePending = services.titles.needsTitle(id);
    if (titlePending) {
      void nameInBackground(services, workspace).catch(() => undefined);
    }

    return reply.send({
      workspace,
      draft: services.workspaces.draft(id, identityOf(request)),
      runs: services.runs.listByWorkspace(id, 20),
      attachments: services.attachments.listForWorkspace(id),
      titlePending,
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
