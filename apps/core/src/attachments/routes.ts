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
    /**
     * El cuerpo tiene que llegar como bytes.
     *
     * Con el parser de `*` eso es lo que pasa siempre salvo con `application/json`, que la API
     * necesita parseado para todo lo demás. Un fichero `.json` adjunto llegaría entonces como
     * objeto, y volver a serializarlo **no** reproduce el original: se dice, en vez de subir algo
     * que no es lo que el usuario eligió.
     */
    const body = request.body as NodeJS.ReadableStream | undefined;
    if (!body || typeof (body as { pipe?: unknown }).pipe !== 'function') {
      throw new JarvisError('BAD_REQUEST',
        'manda el fichero con Content-Type application/octet-stream; su tipo real va en `type`',
        { retryable: false });
    }

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
