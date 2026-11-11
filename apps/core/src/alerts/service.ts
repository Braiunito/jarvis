/**
 * La bandeja de alertas y quien las hace sonar.
 *
 * Guardar y avisar son dos pasos y el primero no depende del segundo: una alerta existe en cuanto
 * está en la base, llegue o no a algún teléfono. El envío push es lo accesorio — un servicio de
 * push caído, un dispositivo que ya no existe o una red que no sale no pueden hacer que se pierda
 * lo que alguien quería contar.
 */
import { createHash } from 'node:crypto';
import type { Database as Db } from 'better-sqlite3';
import { Value } from '@sinclair/typebox/value';
import {
  ALERT_IMPORTANCES, ALERT_ORIGIN_KINDS, CreateAlertRequest, JarvisError, PushSubscriptionRequest,
  alertImportanceRank,
  type Alert, type AlertImportance, type AlertList, type AlertOrigin, type AlertOriginKind,
  type AlertPushPayload, type PushDevice, type PushStatus,
} from '@jarvis/contracts';
import type { Clock } from '../platform/clock.js';
import { opaqueId } from '../platform/ids.js';
import {
  assertVapidKeys, generateVapidKeys, sendPush as defaultSendPush, type PushUrgency, type VapidKeys,
} from './webpush.js';

interface AlertRow {
  id: string;
  created_at: string;
  importance: string;
  title: string;
  body: string | null;
  link: string | null;
  origin_kind: string;
  origin_host: string;
  origin_app: string | null;
  remote_ip: string | null;
  read_at: string | null;
  pushed_to: number;
}

interface SubscriptionRow {
  endpoint: string;
  id: string;
  p256dh: string;
  auth: string;
  user_id: string;
  label: string | null;
  min_importance: string;
  created_at: string;
  last_ok_at: string | null;
  last_error: string | null;
  failures: number;
}

const toAlert = (row: AlertRow): Alert => ({
  id: row.id,
  createdAt: row.created_at,
  importance: row.importance as AlertImportance,
  title: row.title,
  body: row.body,
  link: row.link,
  origin: { kind: row.origin_kind as AlertOriginKind, host: row.origin_host, app: row.origin_app },
  readAt: row.read_at,
  pushedTo: row.pushed_to,
});

/** El id de un dispositivo: resume el endpoint sin enseñarlo, que con él se le podría escribir. */
export const deviceId = (endpoint: string): string =>
  createHash('sha256').update(endpoint).digest('hex').slice(0, 16);

const serviceOf = (endpoint: string): string => {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'desconocido';
  }
};

const toDevice = (row: SubscriptionRow): PushDevice => ({
  id: row.id,
  label: row.label,
  service: serviceOf(row.endpoint),
  minImportance: row.min_importance as AlertImportance,
  createdAt: row.created_at,
  lastOkAt: row.last_ok_at,
  lastError: row.last_error,
});

/**
 * Un enlace sólo puede llevar a la consola o a una web: nada de `javascript:` ni `data:`, que en el
 * `href` de la lista o en el `openWindow` del service worker ejecutarían lo que mande la API.
 */
function safeLink(link: string | undefined | null): string | null {
  if (!link) return null;
  if (link.startsWith('/') && !link.startsWith('//')) return link;
  try {
    const url = new URL(link);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString();
  } catch {
    // cae abajo
  }
  throw new JarvisError('VALIDATION_FAILED', 'link must be a console path (/runs/…) or an http(s) URL');
}

/** Cómo de urgente se lo pide el core al servicio de push: lo grave despierta al teléfono. */
const URGENCY: Record<AlertImportance, PushUrgency> = {
  low: 'low', normal: 'normal', high: 'high', critical: 'high',
};

export interface AlertServiceOptions {
  db: Db;
  clock: Clock;
  /** Contacto que va en el JWT de VAPID (`mailto:` o `https:`). */
  pushSubject: string;
  /** Un par VAPID fijado desde fuera; si no, se genera y se guarda en la base la primera vez. */
  vapidKeys?: VapidKeys | null;
  /** Cuántas alertas por minuto acepta la API antes de devolver 429. */
  apiPerMinute: number;
  retentionDays: number;
  maxStored: number;
  /** Para las pruebas: no salir a internet. */
  sendPush?: typeof defaultSendPush;
  onWarn?: (message: string) => void;
}

export interface CreateAlertInput {
  title: string;
  body?: string | null;
  importance?: AlertImportance;
  link?: string | null;
  origin: AlertOrigin;
  remoteIp?: string | null;
}

/** Fallos seguidos a partir de los cuales un dispositivo se da por perdido y se olvida. */
const MAX_FAILURES = 20;

export class AlertService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #options: AlertServiceOptions;
  readonly #send: typeof defaultSendPush;
  #keys: VapidKeys | null = null;
  #apiWindow: number[] = [];
  /** Envíos en vuelo, para que una prueba (o un apagado) pueda esperarlos. */
  readonly #inflight = new Set<Promise<unknown>>();

  constructor(options: AlertServiceOptions) {
    this.#db = options.db;
    this.#clock = options.clock;
    this.#options = options;
    this.#send = options.sendPush ?? defaultSendPush;
  }

  // ---- claves ---------------------------------------------------------------

  vapidKeys(): VapidKeys {
    if (this.#keys) return this.#keys;
    if (this.#options.vapidKeys) {
      assertVapidKeys(this.#options.vapidKeys);
      this.#keys = this.#options.vapidKeys;
      return this.#keys;
    }
    const row = this.#db.prepare('SELECT public_key, private_key FROM push_vapid WHERE id = 1')
      .get() as { public_key: string; private_key: string } | undefined;
    if (row) {
      this.#keys = { publicKey: row.public_key, privateKey: row.private_key };
      return this.#keys;
    }
    const keys = generateVapidKeys();
    this.#db.prepare('INSERT OR IGNORE INTO push_vapid (id, public_key, private_key, created_at) VALUES (1, ?, ?, ?)')
      .run(keys.publicKey, keys.privateKey, this.#clock.nowIso());
    // Si otro proceso ganó la carrera, manda lo que quedó escrito.
    return this.vapidKeys();
  }

  // ---- la bandeja -----------------------------------------------------------

  /** Valida lo que llega por la API. El tipo de origen no se acepta: por la API, todo es `api`. */
  parseApiRequest(body: unknown): CreateAlertRequest {
    if (!Value.Check(CreateAlertRequest, body)) {
      const first = [...Value.Errors(CreateAlertRequest, body)][0];
      throw new JarvisError('VALIDATION_FAILED',
        first ? `${first.path || 'body'}: ${first.message}` : 'invalid alert');
    }
    return body;
  }

  /**
   * Un tope por minuto para lo que entra por la API: un script en bucle no puede convertir el
   * teléfono en un timbre. Jarvis no pasa por aquí.
   */
  takeApiSlot(): void {
    const now = this.#clock.nowMs();
    this.#apiWindow = this.#apiWindow.filter((at) => now - at < 60_000);
    if (this.#apiWindow.length >= this.#options.apiPerMinute) {
      throw new JarvisError('RATE_LIMITED',
        `more than ${this.#options.apiPerMinute} alerts in the last minute; try again later`);
    }
    this.#apiWindow.push(now);
  }

  /** Guarda la alerta. El envío push sale aparte con `dispatch`. */
  record(input: CreateAlertInput): Alert {
    const importance = input.importance ?? 'normal';
    if (!ALERT_IMPORTANCES.includes(importance)) {
      throw new JarvisError('VALIDATION_FAILED', `unknown importance ${String(importance)}`);
    }
    if (!ALERT_ORIGIN_KINDS.includes(input.origin.kind)) {
      throw new JarvisError('VALIDATION_FAILED', `unknown origin ${String(input.origin.kind)}`);
    }
    const title = input.title.trim().slice(0, 200);
    if (!title) throw new JarvisError('VALIDATION_FAILED', 'title is required');
    const row: AlertRow = {
      id: opaqueId('al'),
      created_at: this.#clock.nowIso(),
      importance,
      title,
      body: input.body?.trim() ? input.body.trim().slice(0, 4000) : null,
      link: safeLink(input.link),
      origin_kind: input.origin.kind,
      origin_host: input.origin.host.trim().slice(0, 64) || 'desconocido',
      origin_app: input.origin.app?.trim().slice(0, 64) || null,
      remote_ip: input.remoteIp ?? null,
      read_at: null,
      pushed_to: 0,
    };
    this.#db.prepare(`INSERT INTO alerts
      (id, created_at, importance, title, body, link, origin_kind, origin_host, origin_app, remote_ip, read_at, pushed_to)
      VALUES (@id, @created_at, @importance, @title, @body, @link, @origin_kind, @origin_host, @origin_app, @remote_ip, @read_at, @pushed_to)`)
      .run(row);
    this.prune();
    return toAlert(row);
  }

  /** Guardar y avisar, esperando al envío: lo que usa la API, que quiere saber a cuántos llegó. */
  async create(input: CreateAlertInput): Promise<Alert> {
    const alert = this.record(input);
    const pushedTo = await this.dispatch(alert);
    return { ...alert, pushedTo };
  }

  /** Guardar y avisar sin esperar: lo que usa Jarvis desde dentro, que no puede quedarse colgado. */
  notify(input: CreateAlertInput): Alert | null {
    try {
      const alert = this.record(input);
      const pending = this.dispatch(alert).catch(() => 0);
      this.#inflight.add(pending);
      void pending.finally(() => this.#inflight.delete(pending));
      return alert;
    } catch (error) {
      this.#options.onWarn?.(`alert not recorded: ${(error as Error).message}`);
      return null;
    }
  }

  /** Espera a los envíos que estén en vuelo. Para las pruebas y para apagar con orden. */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.#inflight]);
  }

  list(query: {
    limit?: number;
    before?: string;
    importance?: AlertImportance[];
    kind?: AlertOriginKind;
    host?: string;
    unreadOnly?: boolean;
  } = {}): AlertList {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.before) { where.push('created_at < ?'); params.push(query.before); }
    if (query.importance?.length) {
      where.push(`importance IN (${query.importance.map(() => '?').join(',')})`);
      params.push(...query.importance);
    }
    if (query.kind) { where.push('origin_kind = ?'); params.push(query.kind); }
    if (query.host) { where.push('origin_host = ?'); params.push(query.host); }
    if (query.unreadOnly) where.push('read_at IS NULL');
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const rows = this.#db.prepare(`SELECT * FROM alerts ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(...params, limit) as AlertRow[];

    const unreadRows = this.#db.prepare(
      'SELECT importance, COUNT(*) AS n FROM alerts WHERE read_at IS NULL GROUP BY importance',
    ).all() as Array<{ importance: AlertImportance; n: number }>;
    const unread = unreadRows.reduce((sum, row) => sum + row.n, 0);
    const unreadTop = unreadRows.reduce<AlertImportance | null>((top, row) =>
      top === null || alertImportanceRank(row.importance) > alertImportanceRank(top) ? row.importance : top, null);
    const hosts = (this.#db.prepare('SELECT DISTINCT origin_host AS host FROM alerts ORDER BY origin_host')
      .all() as Array<{ host: string }>).map((row) => row.host);

    return { alerts: rows.map(toAlert), unread, unreadTop, hosts };
  }

  markRead({ ids, all }: { ids?: string[]; all?: boolean }): number {
    const at = this.#clock.nowIso();
    if (all) {
      return this.#db.prepare('UPDATE alerts SET read_at = ? WHERE read_at IS NULL').run(at).changes;
    }
    if (!ids?.length) return 0;
    const placeholders = ids.map(() => '?').join(',');
    return this.#db.prepare(`UPDATE alerts SET read_at = ? WHERE read_at IS NULL AND id IN (${placeholders})`)
      .run(at, ...ids).changes;
  }

  remove(id: string): boolean {
    return this.#db.prepare('DELETE FROM alerts WHERE id = ?').run(id).changes > 0;
  }

  /** Lo viejo se va solo: 30 días y, como mucho, unas cuantas miles. */
  prune(): void {
    const cutoff = new Date(this.#clock.nowMs() - this.#options.retentionDays * 86_400_000).toISOString();
    this.#db.prepare('DELETE FROM alerts WHERE created_at < ?').run(cutoff);
    this.#db.prepare(`DELETE FROM alerts WHERE id IN (
      SELECT id FROM alerts ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)`).run(this.#options.maxStored);
  }

  // ---- dispositivos ---------------------------------------------------------

  pushStatus(): PushStatus {
    const rows = this.#db.prepare('SELECT * FROM push_subscriptions ORDER BY created_at').all() as SubscriptionRow[];
    return { publicKey: this.vapidKeys().publicKey, devices: rows.map(toDevice) };
  }

  subscribe(userId: string, body: unknown): PushDevice {
    if (!Value.Check(PushSubscriptionRequest, body)) {
      const first = [...Value.Errors(PushSubscriptionRequest, body)][0];
      throw new JarvisError('VALIDATION_FAILED',
        first ? `${first.path || 'body'}: ${first.message}` : 'invalid push subscription');
    }
    const id = deviceId(body.endpoint);
    this.#db.prepare(`INSERT INTO push_subscriptions
      (endpoint, id, p256dh, auth, user_id, label, min_importance, created_at, failures)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(endpoint) DO UPDATE SET
        p256dh = excluded.p256dh, auth = excluded.auth, user_id = excluded.user_id,
        label = COALESCE(excluded.label, push_subscriptions.label),
        min_importance = excluded.min_importance, failures = 0, last_error = NULL`)
      .run(body.endpoint, id, body.keys.p256dh, body.keys.auth, userId,
        body.label?.trim() || null, body.minImportance ?? 'normal', this.#clock.nowIso());
    return toDevice(this.#db.prepare('SELECT * FROM push_subscriptions WHERE id = ?').get(id) as SubscriptionRow);
  }

  unsubscribe({ endpoint, id }: { endpoint?: string; id?: string }): boolean {
    if (endpoint) return this.#db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint).changes > 0;
    if (id) return this.#db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(id).changes > 0;
    return false;
  }

  /**
   * Manda la alerta a cada dispositivo que la quiera. Devuelve a cuántos llegó.
   *
   * `low` no suena nunca: es «que conste», no «mírame».
   */
  async dispatch(alert: Alert): Promise<number> {
    if (alert.importance === 'low') return 0;
    const rank = alertImportanceRank(alert.importance);
    const targets = (this.#db.prepare('SELECT * FROM push_subscriptions').all() as SubscriptionRow[])
      .filter((row) => alertImportanceRank(row.min_importance as AlertImportance) <= rank);
    if (targets.length === 0) return 0;

    let keys: VapidKeys;
    try {
      keys = this.vapidKeys();
    } catch (error) {
      this.#options.onWarn?.(`push disabled: ${(error as Error).message}`);
      return 0;
    }

    const payload: AlertPushPayload = {
      id: alert.id, title: alert.title, body: alert.body, importance: alert.importance,
      origin: alert.origin, link: alert.link, createdAt: alert.createdAt,
    };
    // Un mensaje cifrado cabe en 4 KiB: el cuerpo se recorta para el aviso, no en la bandeja.
    const message = Buffer.from(JSON.stringify({ ...payload, body: payload.body?.slice(0, 1500) ?? null }));

    const results = await Promise.all(targets.map(async (target) => ({
      target,
      result: await this.#send(target, message, {
        keys, subject: this.#options.pushSubject, urgency: URGENCY[alert.importance],
      }),
    })));

    let delivered = 0;
    const at = this.#clock.nowIso();
    for (const { target, result } of results) {
      if (result.ok) {
        delivered += 1;
        this.#db.prepare('UPDATE push_subscriptions SET last_ok_at = ?, last_error = NULL, failures = 0 WHERE endpoint = ?')
          .run(at, target.endpoint);
      } else if (result.gone || target.failures + 1 >= MAX_FAILURES) {
        // El navegador la dio de baja (o lleva semanas sin contestar): seguir mandando es ruido.
        this.#db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(target.endpoint);
      } else {
        this.#db.prepare('UPDATE push_subscriptions SET last_error = ?, failures = failures + 1 WHERE endpoint = ?')
          .run(result.error, target.endpoint);
        this.#options.onWarn?.(`push to ${serviceOf(target.endpoint)} failed: ${result.error}`);
      }
    }
    this.#db.prepare('UPDATE alerts SET pushed_to = ? WHERE id = ?').run(delivered, alert.id);
    return delivered;
  }
}
