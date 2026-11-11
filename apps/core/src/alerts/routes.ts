import type { FastifyInstance } from 'fastify';
import {
  ALERT_IMPORTANCES, ALERT_ORIGIN_KINDS, JarvisError,
  type AlertImportance, type AlertOriginKind, type MarkAlertsReadRequest,
} from '@jarvis/contracts';
import { identityOf } from '../app.js';
import type { CoreServices } from '../services.js';

/**
 * La IP que vio el gateway. La pone él en cada petición que reenvía —y borra la que traiga el
 * cliente—, así que aquí se puede creer: al core sólo llega lo que firmó el gateway.
 */
export const CLIENT_IP_HEADER = 'x-jarvis-client-ip';

export function registerAlertRoutes(app: FastifyInstance, services: CoreServices): void {
  const { alerts } = services;

  /**
   * Crear una alerta. Es la puerta de la API: el gateway deja entrar aquí con la clave de alertas
   * además de con sesión, y en los dos casos el origen es `api`. Contesta cuando el envío push ha
   * terminado, para que quien la mandó sepa a cuántos dispositivos llegó.
   */
  app.post('/api/alerts', async (request, reply) => {
    const body = alerts.parseApiRequest(request.body ?? {});
    alerts.takeApiSlot();
    const ip = request.headers[CLIENT_IP_HEADER];
    const remoteIp = typeof ip === 'string' && ip ? ip : null;
    const alert = await alerts.create({
      title: body.title,
      body: body.body ?? null,
      importance: body.importance ?? 'normal',
      link: body.link ?? null,
      origin: { kind: 'api', host: body.host ?? remoteIp ?? 'desconocido', app: body.app ?? null },
      remoteIp,
    });
    request.log.info({ alert: alert.id, importance: alert.importance, host: alert.origin.host, by: identityOf(request).username },
      'alert received');
    return reply.code(201).send(alert);
  });

  app.get('/api/alerts', async (request, reply) => {
    const query = (request.query ?? {}) as {
      limit?: string; before?: string; importance?: string; kind?: string; host?: string; unread?: string;
    };
    const importance = (query.importance ?? '').split(',').map((value) => value.trim()).filter(Boolean);
    if (importance.some((value) => !(ALERT_IMPORTANCES as readonly string[]).includes(value))) {
      throw new JarvisError('VALIDATION_FAILED', `importance must be one of ${ALERT_IMPORTANCES.join(', ')}`);
    }
    if (query.kind && !(ALERT_ORIGIN_KINDS as readonly string[]).includes(query.kind)) {
      throw new JarvisError('VALIDATION_FAILED', `kind must be one of ${ALERT_ORIGIN_KINDS.join(', ')}`);
    }
    return reply.send(alerts.list({
      ...(query.limit ? { limit: Number(query.limit) || 50 } : {}),
      ...(query.before ? { before: query.before } : {}),
      ...(importance.length ? { importance: importance as AlertImportance[] } : {}),
      ...(query.kind ? { kind: query.kind as AlertOriginKind } : {}),
      ...(query.host ? { host: query.host } : {}),
      unreadOnly: query.unread === '1' || query.unread === 'true',
    }));
  });

  app.post('/api/alerts/read', async (request, reply) => {
    const body = (request.body ?? {}) as MarkAlertsReadRequest;
    if (body.ids !== undefined && (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string'))) {
      throw new JarvisError('VALIDATION_FAILED', 'ids must be a list of alert ids');
    }
    return reply.send({ updated: alerts.markRead({ ids: body.ids?.slice(0, 500) ?? [], all: body.all === true }) });
  });

  app.delete('/api/alerts/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!alerts.remove(id)) throw new JarvisError('NOT_FOUND', `unknown alert ${id}`);
    return reply.code(204).send();
  });

  // ---- notificaciones push ----------------------------------------------------

  app.get('/api/alerts/push', async (_request, reply) => reply.send(alerts.pushStatus()));

  app.post('/api/alerts/push/subscriptions', async (request, reply) => {
    const device = alerts.subscribe(identityOf(request).userId, request.body ?? {});
    return reply.code(201).send(device);
  });

  app.post('/api/alerts/push/unsubscribe', async (request, reply) => {
    const body = (request.body ?? {}) as { endpoint?: unknown; id?: unknown };
    alerts.unsubscribe({
      ...(typeof body.endpoint === 'string' ? { endpoint: body.endpoint } : {}),
      ...(typeof body.id === 'string' ? { id: body.id } : {}),
    });
    return reply.code(204).send();
  });

  /** Una alerta de verdad, para comprobar de punta a punta que un dispositivo la recibe. */
  app.post('/api/alerts/push/test', async (request, reply) => {
    const alert = await alerts.create({
      title: 'Prueba de notificaciones',
      body: `Si lees esto en el dispositivo, las alertas de Jarvis llegan. La pidió ${identityOf(request).username}.`,
      importance: 'normal',
      link: '/alerts',
      origin: { kind: 'jarvis', host: services.config.alertsSelfHost, app: 'prueba' },
    });
    return reply.code(201).send(alert);
  });
}
