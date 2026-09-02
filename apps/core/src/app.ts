/**
 * El core: API, casos de uso y vigilancia de runs.
 *
 * Nada entra sin una identidad firmada por el gateway (ADR-001). Las rutas son delgadas a
 * propósito: validar, llamar a un caso de uso, serializar.
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { JarvisError, type UserIdentity } from '@jarvis/contracts';
import { IDENTITY_HEADER, internalSecret, REQUEST_ID_HEADER, verifyIdentityHeader } from './auth-boundary/identity.js';
import { newRequestId } from './platform/ids.js';
import { registerFleetRoutes } from './fleet/routes.js';
import { registerSessionRoutes } from './sessions/routes.js';
import { registerWorkspaceRoutes } from './workspaces/routes.js';
import { registerRunRoutes } from './runs/routes.js';
import { registerAttachmentRoutes } from './attachments/routes.js';
import { registerUsageRoutes } from './usage/routes.js';
import { registerHealthRoutes } from './health/routes.js';
import { registerTerminalRoutes } from './terminal/routes.js';
import type { CoreServices } from './services.js';

declare module 'fastify' {
  interface FastifyRequest {
    identity: UserIdentity;
  }
}

export interface BuildAppOptions {
  services: CoreServices;
  logger?: boolean;
  /** Sólo para tests: saltarse la verificación de firma exige decirlo explícitamente. */
  trustAllIdentities?: boolean;
}

export function buildApp({ services, logger = false, trustAllIdentities = false }: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger,
    genReqId: () => newRequestId(),
    bodyLimit: 2 * 1024 * 1024,
  });

  /**
   * El límite de confianza.
   *
   * `/internal/health` queda fuera para que el healthcheck de Docker no necesite la clave; no
   * revela nada más que si el proceso está en pie.
   */
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/internal/')) return;
    if (trustAllIdentities) {
      request.identity = { userId: 'test-user', username: 'test' };
      return;
    }
    const identity = verifyIdentityHeader(request.headers[IDENTITY_HEADER] as string | undefined, internalSecret());
    if (!identity) {
      await reply.code(401).send({
        error: {
          code: 'UNAUTHENTICATED',
          message: 'this endpoint only accepts requests signed by the gateway',
          retryable: false,
          requestId: String(request.id),
        },
      });
      return;
    }
    request.identity = { userId: identity.userId, username: identity.username };
    const forwarded = request.headers[REQUEST_ID_HEADER];
    if (typeof forwarded === 'string' && forwarded) request.id = forwarded;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof JarvisError) {
      void reply.code(error.statusCode).send(error.toBody(String(request.id)));
      return;
    }
    if ((error as { validation?: unknown }).validation) {
      void reply.code(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: (error as Error).message,
          retryable: false,
          requestId: String(request.id),
        },
      });
      return;
    }
    request.log.error({ err: error }, 'unhandled error');
    void reply.code(500).send({
      error: { code: 'INTERNAL', message: 'internal error', retryable: false, requestId: String(request.id) },
    });
  });

  /**
   * Los adjuntos viajan como bytes y no se parsean: el stream se pasa tal cual al servicio, que
   * lo empuja por SSH sin acumularlo en memoria.
   */
  app.addContentTypeParser('*', (_request, payload, done) => {
    done(null, payload);
  });

  app.get('/internal/health', async (_request, reply) => reply.send({ ok: true, service: 'jarvis-core' }));

  registerHealthRoutes(app, services);
  registerFleetRoutes(app, services);
  registerSessionRoutes(app, services);
  registerWorkspaceRoutes(app, services);
  registerRunRoutes(app, services);
  registerAttachmentRoutes(app, services);
  registerUsageRoutes(app, services);
  registerTerminalRoutes(app, services);

  return app;
}

export const identityOf = (request: FastifyRequest): UserIdentity => request.identity;
