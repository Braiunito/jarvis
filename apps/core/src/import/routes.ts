import type { FastifyInstance } from 'fastify';
import type { LiteChatExport } from '@jarvis/contracts';
import { identityOf } from '../app.js';
import type { CoreServices } from '../services.js';

export function registerImportRoutes(app: FastifyInstance, services: CoreServices): void {
  /**
   * Importar es idempotente por `sourceInstallationId + sourceConversationId`: repetir el mismo
   * fichero no crea nada nuevo, y el informe dice exactamente qué entró y qué se saltó.
   */
  app.post('/api/migrations/litechat', async (request, reply) => {
    const payload = request.body as LiteChatExport;
    const report = services.imports.import(payload, identityOf(request), String(request.id));
    return reply.send({ report });
  });

  app.get('/api/workspaces/:id/imported', async (request, reply) => {
    const { id } = request.params as { id: string };
    services.workspaces.require(id);
    return reply.send({ messages: services.imports.messagesFor(id) });
  });
}
