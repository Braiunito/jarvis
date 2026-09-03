/**
 * Proxy autenticado hacia el core.
 *
 * Un solo origen para el navegador, que es lo que permite proteger todo con una cookie HttpOnly
 * sin CORS ni tokens en JavaScript. La cookie de sesión se elimina antes de reenviar: el core
 * autentica al gateway por su identidad firmada y nunca ve (ni puede reproducir) una sesión.
 *
 * Contrato EDGE-PROXY-01.
 */
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import { config } from './config.js';
import { IDENTITY_HEADER, REQUEST_ID_HEADER, signIdentity } from './lib/identity.js';

/**
 * Cabeceras que pertenecen a este salto y no se copian al siguiente.
 *
 * `authorization` está en la lista a propósito: la credencial que el core comprueba es la
 * identidad firmada de abajo, y lo que el navegador quiera mandar no lo es.
 */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'authorization',
  IDENTITY_HEADER,
]);

export interface ProxyUser { userId: string; username: string }

function buildHeaders(req: IncomingMessage, target: URL, user: ProxyUser, requestId: string): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === 'cookie' || lower === 'host' || value === undefined) continue;
    headers[name] = value;
  }
  headers['host'] = target.host;
  headers[IDENTITY_HEADER] = signIdentity({ userId: user.userId, username: user.username, requestId }, config.internalSecret);
  headers[REQUEST_ID_HEADER] = requestId;
  return headers;
}

/**
 * El plazo del core, aplicado donde tiene sentido.
 *
 * `JARVIS_CORE_TIMEOUT_MS` estaba en la configuración y no lo usaba nadie: un core que acepta la
 * conexión y luego calla dejaba la petición abierta para siempre, consumiendo sockets y con la
 * consola en «cargando» sin nada que la saque de ahí. Un fallo silencioso es peor que uno ruidoso
 * porque nadie lo diagnostica.
 *
 * El plazo cubre **hasta que llegan las cabeceras**, no la respuesta entera: un stream de eventos
 * dura horas por diseño y cortarlo a los treinta segundos rompería justo lo que sostiene la
 * pantalla de un trabajo. Después de las cabeceras se aplica un plazo de inactividad, salvo a los
 * `text/event-stream`.
 *
 * A un stream no se le pone plazo porque **su latido es contrato del core**: `KEEPALIVE_MS` en
 * `apps/core/src/runs/sse.ts`, hoy 15 s. Esa dependencia es de las que se rompen en silencio — si
 * ese latido desapareciera o se espaciara más que este plazo, aquí no se notaría nada y allí un
 * stream muerto podría quedarse abierto. Quien lo cambie tiene que mirar también esto.
 */
function timeoutError(): Error {
  return Object.assign(new Error(`the core did not answer in ${config.coreTimeoutMs}ms`), {
    jarvisTimeout: true,
  });
}

const wasTimeout = (error: Error): boolean =>
  (error as Error & { jarvisTimeout?: boolean }).jarvisTimeout === true;

export function proxyToCore(
  req: IncomingMessage,
  res: ServerResponse,
  { path, user, requestId }: { path: string; user: ProxyUser; requestId: string },
): void {
  const target = new URL(config.coreUrl);
  const query = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  const requester = target.protocol === 'https:' ? httpsRequest : httpRequest;

  const upstream = requester({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    method: req.method,
    path: `${path}${query}`,
    headers: buildHeaders(req, target, user, requestId),
  }, (upstreamRes) => {
    clearTimeout(headerTimer);
    const outHeaders: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      if (HOP_BY_HOP.has(name.toLowerCase()) || value === undefined) continue;
      outHeaders[name] = value;
    }
    // Los server-sent events no pueden quedarse en un búfer por el camino.
    const isEventStream = String(upstreamRes.headers['content-type'] ?? '').includes('text/event-stream');
    if (isEventStream) {
      outHeaders['x-accel-buffering'] = 'no';
      outHeaders['cache-control'] = 'no-cache, no-transform';
    }
    res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
    // Sólo después de writeHead: vaciar antes fija un 200 por defecto y las cabeceras reales se
    // rechazan, lo que mata el stream justo al empezar.
    if (isEventStream) res.flushHeaders?.();
    // Ya hay cabeceras: lo que queda es cuerpo. A un stream de eventos no se le pone plazo —su
    // latido lo decide el core—; a todo lo demás, inactividad.
    if (!isEventStream) {
      upstream.setTimeout(config.coreTimeoutMs, () => upstream.destroy(timeoutError()));
    }
    upstreamRes.pipe(res);
  });

  const headerTimer = setTimeout(() => upstream.destroy(timeoutError()), config.coreTimeoutMs);

  upstream.on('error', (error) => {
    clearTimeout(headerTimer);
    if (!res.headersSent) {
      // Se distingue «no llegué» de «llegué y no contestó»: la primera se reintenta sola, la
      // segunda quiere decir que el core está vivo y atascado, y eso se mira en Salud.
      const timedOut = wasTimeout(error);
      res.writeHead(timedOut ? 504 : 502, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        error: {
          code: timedOut ? 'CORE_TIMEOUT' : 'UPSTREAM_UNAVAILABLE',
          message: timedOut
            ? `the core accepted the request and did not answer in ${config.coreTimeoutMs}ms`
            : `the core is unreachable: ${error.message}`,
          retryable: true,
          requestId,
        },
      }));
    } else {
      res.end();
    }
  });

  // Si el cliente cuelga a mitad de un stream, se tira la petición upstream en vez de filtrarla.
  res.on('close', () => { clearTimeout(headerTimer); upstream.destroy(); });

  req.pipe(upstream);
}

/**
 * Reenvía un upgrade de WebSocket al core.
 *
 * Una terminal viva es un WebSocket, y un proxy que sólo entienda petición/respuesta la dejaría
 * inalcanzable. El handshake es una petición HTTP normal cuya respuesta 101 entrega el socket.
 */
export function proxyUpgradeToCore(
  req: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  { path, user, requestId }: { path: string; user: ProxyUser; requestId: string },
): void {
  const target = new URL(config.coreUrl);
  const query = req.url?.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';

  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    // Aquí sí se conservan connection y upgrade: son el handshake. La Authorization del cliente
    // se descarta igual.
    if (lower === 'cookie' || lower === 'host' || lower === 'authorization' || value === undefined) continue;
    headers[name] = value;
  }
  headers['host'] = target.host;
  headers[IDENTITY_HEADER] = signIdentity({ userId: user.userId, username: user.username, requestId }, config.internalSecret);
  headers[REQUEST_ID_HEADER] = requestId;

  const requester = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const upstream = requester({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    method: req.method,
    path: `${path}${query}`,
    headers,
  });

  /*
   * El handshake también tiene plazo, y sólo el handshake.
   *
   * Una terminal viva puede estar horas sin decir nada —nadie teclea— así que el plazo se levanta
   * en cuanto el core acepta el upgrade. Lo que no puede quedarse abierto para siempre es el
   * intento de abrirla.
   */
  const handshakeTimer = setTimeout(() => {
    upstream.destroy(timeoutError());
    clientSocket.end('HTTP/1.1 504 Gateway Timeout\r\n\r\n');
  }, config.coreTimeoutMs);

  upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    clearTimeout(handshakeTimer);
    const lines = [`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}`];
    for (const [name, value] of Object.entries(upstreamRes.headers)) {
      lines.push(`${name}: ${String(value)}`);
    }
    clientSocket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (upstreamHead?.length) clientSocket.write(upstreamHead);

    // La latencia importa al teclear: que Nagle no agrupe pulsaciones sueltas.
    (clientSocket as unknown as { setNoDelay?: (v: boolean) => void }).setNoDelay?.(true);
    upstreamSocket.setNoDelay(true);
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);

    const shutdown = (): void => {
      upstreamSocket.destroy();
      clientSocket.destroy();
    };
    upstreamSocket.on('error', shutdown);
    clientSocket.on('error', shutdown);
    upstreamSocket.on('close', shutdown);
    clientSocket.on('close', shutdown);
  });

  upstream.on('response', (upstreamRes) => {
    clearTimeout(handshakeTimer);
    // El core se negó a hacer upgrade: se pasa la negativa en vez de dejar al cliente colgado.
    clientSocket.end(`HTTP/1.1 ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n\r\n`);
  });
  upstream.on('error', (error) => {
    clearTimeout(handshakeTimer);
    // Si el plazo ya contestó 504, no se escribe encima.
    if (!wasTimeout(error)) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
  });
  clientSocket.on('close', () => clearTimeout(handshakeTimer));

  if (head?.length) upstream.write(head);
  upstream.end();
}
