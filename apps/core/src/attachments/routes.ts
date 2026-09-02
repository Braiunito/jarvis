import type { FastifyInstance } from 'fastify';
import { JarvisError } from '@jarvis/contracts';
import { identityOf } from '../app.js';
import type { CoreServices } from '../services.js';

export function registerAttachmentRoutes(app: FastifyInstance, services: CoreServices): void {
  /**
   * Subida en streaming: el cuerpo no se acumula en memoria ni se guarda en el core, va directo
   * al host donde el agente lo va a leer.
   */
  app.post('/api/attachments', async (request, reply) => {
    const query = (request.query ?? {}) as { workspaceId?: string; name?: string; type?: string };
    if (!query.workspaceId) throw new JarvisError('BAD_REQUEST', 'workspaceId is required');
    const workspace = services.workspaces.require(query.workspaceId);
    const target = await services.runs.planTarget(workspace, {});
    const sizeBytes = Number(request.headers['content-length']);
    if (!request.headers['content-length']) {
      throw new JarvisError('BAD_REQUEST', 'a Content-Length is required to reserve quota before streaming');
    }
    // El parser de octet-stream devuelve el propio stream; para cualquier otro tipo se usa el
    // crudo, que a esas alturas nadie ha tocado.
    const body = (request.body as NodeJS.ReadableStream | undefined) ?? request.raw;

    const attachment = await services.attachments.stage(body as never, {
      user: identityOf(request),
      target,
      sessionHost: workspace.ref.host,
      workspaceId: workspace.id,
      scopeId: workspace.id,
      displayName: query.name ?? 'attachment',
      mimeType: query.type ?? 'application/octet-stream',
      sizeBytes,
    });
    return reply.code(201).send({ attachment });
  });

  app.get('/api/attachments/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const attachment = services.attachments.find(id);
    if (!attachment) throw new JarvisError('NOT_FOUND', `unknown attachment ${id}`, { scope: { attachmentId: id } });
    return reply.send({ attachment });
  });
}
