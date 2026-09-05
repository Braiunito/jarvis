/**
 * Las rutas de la conversación.
 *
 * Delgadas como el resto: validar, llamar al caso de uso, serializar. Lo único con algo de
 * sustancia es el stream, y lo que tiene es el mismo contrato que el de los runs —`id: <seq>`,
 * `Last-Event-ID`, replay desde SQLite— porque es el mismo problema: una conexión que se cae no
 * puede perder lo que ya estaba escrito.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { JarvisError } from '@jarvis/contracts';
import { identityOf } from '../app.js';
import type { CoreServices } from '../services.js';

/** El mismo latido que el de los runs. Si cambia uno, hay que mirar el proxy (ver architecture). */
const KEEPALIVE_MS = 15_000;

export function registerChatRoutes(app: FastifyInstance, services: CoreServices): void {
  app.post('/api/chat', async (request, reply) => {
    const body = (request.body ?? {}) as {
      title?: string; workspaceId?: string; autonomy?: 'manual' | 'auto'; message?: string;
    };
    if (body.autonomy && body.autonomy !== 'manual' && body.autonomy !== 'auto') {
      throw new JarvisError('BAD_REQUEST', 'autonomy debe ser manual o auto');
    }
    const conversation = services.chat.create({
      ...(body.title ? { title: body.title } : {}),
      ...(body.workspaceId ? { workspaceId: body.workspaceId } : {}),
      ...(body.autonomy ? { autonomy: body.autonomy } : {}),
      user: identityOf(request),
    });
    // Crear con el primer mensaje ahorra un viaje: es lo que hace la interfaz al escribir y enviar.
    if (body.message?.trim()) {
      services.chat.send(conversation.id, body.message, identityOf(request));
    }
    return reply.code(201).send({ conversation: services.chat.require(conversation.id) });
  });

  app.get('/api/chat', async (request, reply) => {
    const query = (request.query ?? {}) as { workspaceId?: string; limit?: string };
    const limit = Number.parseInt(query.limit ?? '', 10);
    return reply.send({
      conversations: services.chat.list({
        ...(query.workspaceId ? { workspaceId: query.workspaceId } : {}),
        ...(Number.isFinite(limit) && limit > 0 ? { limit: Math.min(limit, 100) } : {}),
      }),
      capabilities: await services.chat.capabilities(),
    });
  });

  app.get('/api/chat/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const afterSeq = Number.parseInt((request.query as { afterSeq?: string } | undefined)?.afterSeq ?? '', 10);
    return reply.send({
      conversation: services.chat.require(id),
      messages: services.chat.messages(id, Number.isFinite(afterSeq) ? { afterSeq } : {}),
      approvals: services.chat.pendingApprovals(id),
    });
  });

  app.post('/api/chat/:id/messages', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { text?: string };
    if (!body.text) throw new JarvisError('BAD_REQUEST', 'text es obligatorio');
    // 202: el turno va por detrás y se sigue por el stream, igual que un run.
    return reply.code(202).send({ message: services.chat.send(id, body.text, identityOf(request)) });
  });

  app.post('/api/chat/:id/autonomy', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { autonomy?: 'manual' | 'auto' };
    if (body.autonomy !== 'manual' && body.autonomy !== 'auto') {
      throw new JarvisError('BAD_REQUEST', 'autonomy debe ser manual o auto');
    }
    return reply.send({ conversation: services.chat.setAutonomy(id, body.autonomy, identityOf(request)) });
  });

  app.delete('/api/chat/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    services.chat.delete(id, identityOf(request));
    return reply.code(204).send();
  });

  /** Qué capacidades hay enchufadas y cómo están. Para la pantalla, no para el modelo. */
  app.get('/api/capabilities', async (_request, reply) => {
    if (!services.mcp.configured) return reply.send({ servers: [], areas: [], capabilities: [] });
    const [servers, areas, capabilities] = await Promise.all([
      services.mcp.states(),
      services.mcp.areas().catch(() => []),
      services.mcp.capabilities().catch(() => []),
    ]);
    return reply.send({ servers, areas, capabilities });
  });

  /**
   * Lo que llevamos gastado, contado en casa.
   *
   * No es el saldo de la cuenta y la respuesta no finge serlo: el proveedor no lo da —una clave de
   * proyecto recibe 403 al preguntarlo— así que esto son los tokens que este core ha visto pasar,
   * con la tarifa que tiene configurada.
   */
  app.get('/api/spend', async (_request, reply) => reply.send(services.spend.summary()));

  app.get('/events/chat/:id', (request, reply) => {
    const { id } = request.params as { id: string };
    streamChat(request, reply, services, id);
  });
}

/**
 * El stream de una conversación.
 *
 * `Last-Event-ID` es «el último seq que ya vi», así que se manda estrictamente lo que va después.
 * El bus sólo despierta; lo que se envía sale siempre de SQLite, y por eso perder una
 * notificación no pierde un mensaje.
 */
function streamChat(request: FastifyRequest, reply: FastifyReply, services: CoreServices, id: string): void {
  const conversation = services.chat.require(id);

  const header = request.headers['last-event-id'];
  const fromQuery = (request.query as { lastEventId?: string } | undefined)?.lastEventId;
  const parsed = Number.parseInt(String(header ?? fromQuery ?? '-1'), 10);
  let cursor = Number.isFinite(parsed) ? parsed : -1;

  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  reply.raw.flushHeaders?.();

  let closed = false;
  const write = (chunk: string): void => {
    if (closed) return;
    try {
      reply.raw.write(chunk);
    } catch {
      close();
    }
  };

  const flush = (): void => {
    if (closed) return;
    let messages;
    try {
      messages = services.chat.messages(id, { afterSeq: cursor });
    } catch {
      // La conversación se borró mientras alguien la miraba: se cierra sin ruido.
      close();
      return;
    }
    for (const message of messages) {
      cursor = message.seq;
      write(`event: chat.message\nid: ${message.seq}\ndata: ${JSON.stringify(message)}\n\n`);
    }
    // El estado va aparte de los mensajes: «pensando» no es algo que se haya dicho, y meterlo en
    // el hilo dejaría un rastro de mensajes vacíos en el histórico.
    const current = services.chat.find(id);
    if (current) {
      write(`event: chat.state\ndata: ${JSON.stringify({
        status: current.status, source: current.source, autonomy: current.autonomy, title: current.title,
      })}\n\n`);
    }
  };

  const unsubscribe = services.chat.bus.subscribe(id, () => flush());
  const keepalive = setInterval(() => write(': keepalive\n\n'), KEEPALIVE_MS);

  function close(): void {
    if (closed) return;
    closed = true;
    clearInterval(keepalive);
    unsubscribe();
    try {
      reply.raw.end();
    } catch {
      // El socket ya estaba cerrado; no hay nada que rematar.
    }
  }

  request.raw.on('close', close);
  request.raw.on('error', close);

  // Lo que ya había, antes de suscribirse a lo que venga: quien reconecta ve el hueco relleno.
  write(`event: chat.opened\ndata: ${JSON.stringify({ id: conversation.id })}\n\n`);
  flush();
}
