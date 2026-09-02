/**
 * El gateway: un solo origen para todo lo que toca el navegador.
 *
 * Sólo `/auth/*`, la SPA y `/healthz` son alcanzables sin sesión. Todo lo demás pasa por el core
 * con una identidad interna firmada, y la cookie no cruza esa frontera (ADR-001).
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { config } from './config.js';
import { parseCookies, session, SESSION_COOKIE } from './lib/session.js';
import { users } from './lib/store.js';
import { proxyToCore, proxyUpgradeToCore } from './proxy.js';
import { registerAuthRoutes, type SessionUser } from './routes/auth.js';
import { serveStatic } from './static.js';

/** Prefijos que van al core. Cualquier otra cosa es la SPA. */
const CORE_PREFIXES = ['/api', '/events'];
const isCorePath = (pathname: string): boolean =>
  CORE_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

/** La sesión se resuelve desde las cabeceras, vengan de Fastify o del servidor crudo. */
export function userFromHeaders(cookieHeader: string | undefined): SessionUser | null {
  const token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!token) return null;
  const claims = session.read(token);
  if (!claims) return null;
  // Una sesión sobrevive a un `jarvis-users disable`, así que la cuenta se revisa en cada petición.
  const user = users.findByUserId(claims.sub);
  if (!user || !user.enabled) return null;
  return { sub: claims.sub, username: user.username };
}

export const currentUser = (request: FastifyRequest): SessionUser | null =>
  userFromHeaders(request.headers.cookie);

export function buildGateway(options: { logger?: boolean } = {}): FastifyInstance {
  /**
   * El proxy hacia el core se resuelve en el servidor HTTP, antes que Fastify.
   *
   * Es la única forma de reenviar el cuerpo tal cual: en cuanto el framework mira la petición,
   * el stream deja de estar donde el proxy lo espera y la llamada se cuelga esperando bytes que
   * ya nadie va a mandar. Y es también lo que permite subir un adjunto de 20 MiB sin que el
   * gateway lo acumule en memoria.
   */
  const handleRaw = (req: IncomingMessage, res: ServerResponse, fastifyHandler: (req: IncomingMessage, res: ServerResponse) => void): void => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (!isCorePath(pathname)) {
      fastifyHandler(req, res);
      return;
    }
    const requestId = `req_${randomUUID()}`;
    const user = userFromHeaders(req.headers.cookie);
    if (!user) {
      const body = JSON.stringify({
        error: { code: 'UNAUTHENTICATED', message: 'authentication required', retryable: false, requestId },
      });
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    proxyToCore(req, res, { path: pathname, user: { userId: user.sub, username: user.username }, requestId });
  };

  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: config.trustProxy,
    disableRequestLogging: true,
    genReqId: () => `req_${randomUUID()}`,
    // Apagar no puede depender de que todos los clientes se despidan: un socket de terminal
    // abierto dejaría el contenedor colgado hasta que Docker lo matara por timeout.
    forceCloseConnections: true,
    serverFactory: (fastifyHandler) => createServer((req, res) => handleRaw(req, res, fastifyHandler)),
  });

  app.get('/healthz', async (_request, reply) => reply.send({ ok: true, service: 'jarvis-gateway' }));

  registerAuthRoutes(app, currentUser);

  /** Todo lo que no es del core es la aplicación: un solo origen, una sola SPA. */
  app.all('/*', async (request, reply) => {
    const pathname = new URL(request.url, 'http://localhost').pathname;

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return reply.code(404).send({
        error: { code: 'NOT_FOUND', message: 'unknown endpoint', retryable: false, requestId: request.id },
      });
    }

    // La SPA se sirve autenticado o no: no lleva datos, y ella misma pide el login. Así hay una
    // sola aplicación en vez de dos páginas que se desincronizan.
    const result = serveStatic(reply, config.staticDir, pathname, { secureCookies: !config.insecureCookies });
    if (result.served) return reply;
    return reply.code(result.status ?? 404).send({
      error: {
        code: result.status === 403 ? 'FORBIDDEN' : result.status === 503 ? 'UPSTREAM_UNAVAILABLE' : 'NOT_FOUND',
        message: result.message ?? 'not found',
        retryable: false,
        requestId: String(request.id),
      },
    });
  });

  /**
   * Una terminal viva es un WebSocket, autenticado con la misma cookie que todo lo demás: el
   * upgrade es una petición HTTP normal hasta el momento en que se acepta.
   */
  app.server.on('upgrade', (req, socket, head) => {
    // Nada aquí puede lanzar: una excepción en un handler de socket es una excepción no capturada,
    // y eso termina el proceso para todo el mundo.
    try {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      const claims = token ? session.read(token) : null;
      const user = claims ? users.findByUserId(claims.sub) : null;
      if (!user || !user.enabled) {
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
        return;
      }
      let pathname: string;
      try {
        pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname;
      } catch {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
      }
      if (!isCorePath(pathname)) {
        socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
        return;
      }
      proxyUpgradeToCore(req, socket, head, {
        path: pathname,
        user: { userId: user.userId, username: user.username },
        requestId: `req_${randomUUID()}`,
      });
    } catch (error) {
      console.error('[gateway] upgrade failed:', (error as Error).message);
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    }
  });

  return app;
}
