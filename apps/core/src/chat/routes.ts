/**
 * Las rutas de la conversación.
 *
 * Delgadas como el resto: validar, llamar al caso de uso, serializar. Lo único con algo de
 * sustancia es el stream, y lo que tiene es el mismo contrato que el de los runs —`id: <seq>`,
 * `Last-Event-ID`, replay desde SQLite— porque es el mismo problema: una conexión que se cae no
 * puede perder lo que ya estaba escrito.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { JarvisError, type AutonomyMode } from '@jarvis/contracts';
import { identityOf } from '../app.js';
import type { CoreServices } from '../services.js';

/**
 * Que el modo exista y que esta casa lo permita.
 *
 * Las dos cosas en el mismo sitio porque para quien llama son el mismo error —el modo que pide no
 * lo va a tener— y porque separarlas invita a comprobar una y olvidar la otra. `unrestricted`
 * necesita `JARVIS_ALLOW_UNRESTRICTED`: una decisión que amplía lo que la máquina hace sola no
 * puede concederse desde el cliente (ADR-010).
 */
function assertAutonomy(value: unknown, services: CoreServices): asserts value is AutonomyMode {
  const allowed = services.chat.autonomyModes();
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new JarvisError('BAD_REQUEST', `autonomy debe ser ${allowed.join(' o ')}`);
  }
}

/** El mismo latido que el de los runs. Si cambia uno, hay que mirar el proxy (ver architecture). */
const KEEPALIVE_MS = 15_000;

export function registerChatRoutes(app: FastifyInstance, services: CoreServices): void {
  app.post('/api/chat', async (request, reply) => {
    const body = (request.body ?? {}) as {
      title?: string; workspaceId?: string; autonomy?: 'manual' | 'auto'; message?: string;
    };
    if (body.autonomy) assertAutonomy(body.autonomy, services);
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
      // Los `inline` son parte de la respuesta: si no llegan con ella, la primera pintada tiene
      // un hueco. Los `panel` y `modal` se piden al abrirlos, que es cuando se miran.
      artifacts: services.chat.inlineArtifacts(id),
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
    const body = (request.body ?? {}) as { autonomy?: string };
    assertAutonomy(body.autonomy, services);
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

  app.get('/api/chat/:id/artifacts/:artifactId', async (request, reply) => {
    const { id, artifactId } = request.params as { id: string; artifactId: string };
    return reply.send({ artifact: services.chat.artifact(id, artifactId) });
  });

  /**
   * El artifact como documento, para meterlo en un iframe.
   *
   * Aquí es donde vive el aislamiento, y **no depende del atributo del iframe**: `sandbox` va como
   * directiva de CSP en la respuesta, así que el documento cae en un origen opaco **se cargue como
   * se cargue** —embebido o navegando a esta URL a pelo—. Sin eso, abrir este enlace en una
   * pestaña cargaría en el origen de la aplicación, con la cookie de sesión, un documento que
   * escribió un modelo a partir de lo que leyó en una máquina. Eso es XSS almacenado.
   *
   * `script-src` va explícito y no heredado: `default-src 'none'` habría prohibido justo el script
   * que todo esto existe para aislar. Y `form-action` y `base-uri` también, porque **no heredan de
   * `default-src`**: sin ellas, un formulario con envío automático exfiltra sin problema.
   *
   * `connect-src 'none'` e `img-src data:` son lo que impide que llame a casa: ni contar que lo
   * abriste ni sacar lo que lleva dentro. Y que no pueda **navegarse a sí mismo** a un servidor de
   * fuera —la misma baliza por otra puerta— lo sostiene el `frame-src 'self'` de la aplicación,
   * que por eso está declarado explícito y no heredado.
   *
   * **Corrección de lo que aquí decía antes.** Se afirmaba que «ni un intento llega a la red», y
   * era falso: la comprobación cubrió `connect`, `img` y `form`, y no `frame` ni la navegación del
   * documento. Con una lista blanca sin `default-src`, todo lo que no estaba nombrado quedaba
   * permitido —un `<iframe src="http://…">` dentro del artifact cargaba— y abierto como pestaña,
   * `location.href` navegaba, porque el sandbox restringe frames y no al documento raíz.
   *
   * Comprobar tres salidas y concluir que no hay ninguna es el error, no la CSP.
   *
   * **Aviso para quien lo compruebe a mano**: `document.location.origin` devuelve el origen de la
   * URL, no `null`, porque refleja la dirección y no el origen de seguridad. Que el documento esté
   * en un origen opaco lo demuestran los `SecurityError`, no esa línea.
   */
  app.get('/api/chat/:id/artifacts/:artifactId/raw', async (request, reply) => {
    const { id, artifactId } = request.params as { id: string; artifactId: string };
    const artifact = services.chat.artifact(id, artifactId);
    if (artifact.kind !== 'html') {
      throw new JarvisError('BAD_REQUEST', 'sólo un artifact html se sirve como documento');
    }
    if (!services.chat.htmlArtifactsAllowed) {
      throw new JarvisError('FORBIDDEN', 'los artifacts html están desactivados en este servidor');
    }
    /*
     * Sólo embebido en la consola, nunca como pestaña.
     *
     * `sandbox` restringe los **frames**, no al documento raíz: abierto en una pestaña, un
     * `location.href = 'http://…'` navega y se lleva lo que quiera contar. Exigir que la petición
     * venga de un iframe cierra esa puerta entera en vez de intentar tapar cada salida. Todos los
     * navegadores mandan `sec-fetch-dest`, así que lo que se pierde es abrirlo a mano — que es
     * justo lo que no debe poder hacerse.
     */
    const destino = request.headers['sec-fetch-dest'];
    if (destino !== undefined && destino !== 'iframe') {
      throw new JarvisError('FORBIDDEN',
        'este documento sólo se sirve embebido en la consola, no como página');
    }
    return reply
      .header('content-security-policy', [
        /*
         * `default-src 'none'` va **primero y de verdad**.
         *
         * Lo quité en su día creyendo que prohibiría el script que todo esto existe para aislar, y
         * era un error de lectura mío: `default-src` sólo cubre lo que no se declara, y `script-src`
         * está declarado justo debajo. Sin él, todo lo que no estuviera en la lista quedaba
         * permitido — y lo que no estaba era `frame-src`, así que un `<iframe src="http://…">`
         * dentro del artifact cargaba. Una lista blanca parcial no es una lista blanca.
         */
        "default-src 'none'",
        // El origen opaco, que es el aislamiento. Va también como cabecera y no sólo como atributo
        // del iframe, para que valga se cargue como se cargue.
        'sandbox allow-scripts',
        "script-src 'unsafe-inline'",
        "style-src 'unsafe-inline'",
        "img-src data:",
        "font-src data:",
        // Las cuatro que faltaban. `frame-src` es por la que se salía: el `frame-src 'self'` de la
        // aplicación gobierna el iframe de primer nivel, no lo que ese iframe meta dentro.
        "frame-src 'none'",
        "child-src 'none'",
        "worker-src 'none'",
        "media-src 'none'",
        "connect-src 'none'",
        "form-action 'none'",
        "base-uri 'none'",
        "object-src 'none'",
        "frame-ancestors 'self'",
      ].join('; '))
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .header('cache-control', 'private, max-age=31536000, immutable')
      .type('text/html; charset=utf-8')
      .send(artifact.body);
  });

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
      /*
       * Los cuerpos `inline` van **en el mismo frame** y no por un canal aparte.
       *
       * El frame lleva punteros, y un artifact `inline` que llega en vivo se pintaría vacío hasta
       * que algo dispare un refetch —que con `refetchOnWindowFocus: false` puede no llegar nunca—.
       * Es aditivo: quien lea el frame como un `ChatMessage` sigue leyéndolo igual.
       */
      const artifacts = services.chat.inlineArtifactsOf(message.id);
      const payload = artifacts.length ? { ...message, artifacts } : message;
      write(`event: chat.message\nid: ${message.seq}\ndata: ${JSON.stringify(payload)}\n\n`);
    }
    // El estado va aparte de los mensajes: «pensando» no es algo que se haya dicho, y meterlo en
    // el hilo dejaría un rastro de mensajes vacíos en el histórico.
    const current = services.chat.find(id);
    if (current) {
      write(`event: chat.state\ndata: ${JSON.stringify({
        status: current.status, source: current.source, autonomy: current.autonomy, title: current.title,
        /*
         * Con cuánto esfuerzo está pensando ahora mismo, si lo decide él.
         *
         * Nulo cuando no está pensando y cuando el esfuerzo es fijo: un indicador que siempre dice
         * lo mismo no informa, y lo que interesa ver es **el salto** cuando la pasada previa decide
         * que esta pregunta pide más.
         */
        effort: services.chat.effortOf(id),
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
