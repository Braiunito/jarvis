/**
 * Las alertas: la bandeja, a quién suenan y lo que Jarvis cuenta por su cuenta.
 *
 * Lo que más importa fijar no es que se guarden, que es lo fácil, sino las decisiones que no se
 * ven cuando funcionan: que `low` no suene nunca, que un dispositivo dado de baja se olvide, que
 * por la API no se pueda firmar como `jarvis`, que un enlace no pueda ser `javascript:` y que la
 * salud avise de los **cambios** y no cada vez que mira.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Health, Run } from '@jarvis/contracts';
import { migrate, openDatabase } from '../src/platform/db.js';
import { fixedClock } from '../src/platform/clock.js';
import { AlertService, deviceId } from '../src/alerts/service.js';
import { HealthWatch, runAlert } from '../src/alerts/watch.js';
import type { PushResult, PushTarget } from '../src/alerts/webpush.js';
import { buildServices } from '../src/services.js';
import { buildApp } from '../src/app.js';

const NOW = '2026-11-10T12:00:00.000Z';

function setup({ results = [] as Array<Partial<PushResult>>, apiPerMinute = 30 } = {}) {
  const db = openDatabase({ path: ':memory:', skipVersionCheck: true });
  migrate(db);
  const clock = fixedClock(NOW);
  const sent: Array<{ target: PushTarget; payload: Record<string, unknown>; urgency?: string }> = [];
  let call = 0;
  const alerts = new AlertService({
    db, clock, pushSubject: 'mailto:test@example.com', apiPerMinute, retentionDays: 30, maxStored: 5,
    sendPush: async (target, payload, options) => {
      sent.push({ target, payload: JSON.parse(payload.toString()) as Record<string, unknown>, ...(options.urgency ? { urgency: options.urgency } : {}) });
      const result = results[call] ?? {};
      call += 1;
      return { ok: true, status: 201, gone: false, error: null, ...result };
    },
  });
  return { db, clock, alerts, sent };
}

const subscription = (n: number, minImportance?: string) => ({
  endpoint: `https://push.example/device-${n}`,
  keys: { p256dh: 'B'.padEnd(87, 'A'), auth: 'abcdefghijklmnopqrstuv' },
  ...(minImportance ? { minImportance } : {}),
  label: `dispositivo ${n}`,
});

const api = { kind: 'api' as const, host: 'braian', app: 'claude-code' };

describe('la bandeja', () => {
  it('guarda, lista de lo más nuevo a lo más viejo y cuenta las no leídas con la más grave', () => {
    const { alerts, clock } = setup();
    alerts.record({ title: 'uno', importance: 'low', origin: api });
    clock.advance(1000);
    alerts.record({ title: 'dos', importance: 'high', origin: { kind: 'jarvis', host: 'zeus', app: 'salud' } });
    clock.advance(1000);
    alerts.record({ title: 'tres', origin: api });

    const list = alerts.list();
    expect(list.alerts.map((alert) => alert.title)).toEqual(['tres', 'dos', 'uno']);
    expect(list.alerts[0]?.importance).toBe('normal');
    expect(list.unread).toBe(3);
    expect(list.unreadTop).toBe('high');
    expect(list.hosts).toEqual(['braian', 'zeus']);
  });

  it('filtra por importancia, origen, máquina y no leídas, y pagina con before', () => {
    const { alerts, clock } = setup();
    const a = alerts.record({ title: 'a', importance: 'critical', origin: api });
    clock.advance(1000);
    alerts.record({ title: 'b', importance: 'normal', origin: { kind: 'jarvis', host: 'goro2', app: null } });
    clock.advance(1000);
    const c = alerts.record({ title: 'c', importance: 'high', origin: api });

    expect(alerts.list({ importance: ['high', 'critical'] }).alerts.map((x) => x.title)).toEqual(['c', 'a']);
    expect(alerts.list({ kind: 'jarvis' }).alerts.map((x) => x.title)).toEqual(['b']);
    expect(alerts.list({ host: 'braian' }).alerts.map((x) => x.title)).toEqual(['c', 'a']);
    expect(alerts.list({ before: c.createdAt }).alerts.map((x) => x.title)).toEqual(['b', 'a']);

    expect(alerts.markRead({ ids: [a.id] })).toBe(1);
    expect(alerts.list({ unreadOnly: true }).alerts.map((x) => x.title)).toEqual(['c', 'b']);
    expect(alerts.list().unreadTop).toBe('high');
    expect(alerts.markRead({ all: true })).toBe(2);
    expect(alerts.list()).toMatchObject({ unread: 0, unreadTop: null });
  });

  it('un enlace sólo puede ir a la consola o a una web', () => {
    const { alerts } = setup();
    expect(alerts.record({ title: 'x', link: '/runs/r1', origin: api }).link).toBe('/runs/r1');
    expect(alerts.record({ title: 'x', link: 'https://example.com/a', origin: api }).link).toBe('https://example.com/a');
    expect(() => alerts.record({ title: 'x', link: 'javascript:alert(1)', origin: api })).toThrow(/link/);
    expect(() => alerts.record({ title: 'x', link: '//evil.example/x', origin: api })).toThrow(/link/);
  });

  it('se queda con las más nuevas hasta el tope, y lo de hace más de 30 días se va', () => {
    const { alerts, clock } = setup();
    alerts.record({ title: 'vieja', origin: api });
    clock.advance(31 * 86_400_000);
    for (let i = 0; i < 6; i += 1) {
      alerts.record({ title: `n${i}`, origin: api });
      clock.advance(1000);
    }
    expect(alerts.list().alerts.map((x) => x.title)).toEqual(['n5', 'n4', 'n3', 'n2', 'n1']);
  });

  it('la API tiene tope por minuto', () => {
    const { alerts, clock } = setup({ apiPerMinute: 2 });
    alerts.takeApiSlot();
    alerts.takeApiSlot();
    expect(() => alerts.takeApiSlot()).toThrow(/more than 2/);
    clock.advance(61_000);
    expect(() => alerts.takeApiSlot()).not.toThrow();
  });
});

describe('a quién suena', () => {
  it('low no suena; el resto va a quien lo quiere según su mínimo, con la urgencia adecuada', async () => {
    const { alerts, sent } = setup();
    alerts.subscribe('u1', subscription(1));
    alerts.subscribe('u1', subscription(2, 'high'));

    expect((await alerts.create({ title: 'baja', importance: 'low', origin: api })).pushedTo).toBe(0);
    expect(sent).toHaveLength(0);

    expect((await alerts.create({ title: 'normal', origin: api })).pushedTo).toBe(1);
    expect(sent.map((s) => s.target.endpoint)).toEqual(['https://push.example/device-1']);

    const critical = await alerts.create({ title: 'grave', importance: 'critical', link: '/health', origin: api });
    expect(critical.pushedTo).toBe(2);
    expect(sent.at(-1)?.urgency).toBe('high');
    expect(sent.at(-1)?.payload).toMatchObject({ id: critical.id, title: 'grave', importance: 'critical', link: '/health', origin: api });
    expect(alerts.list().alerts[0]?.pushedTo).toBe(2);
  });

  it('un dispositivo dado de baja (410) se olvida; uno que falla se queda con el error', async () => {
    const { alerts } = setup({ results: [{ ok: false, status: 410, gone: true, error: '410' }, { ok: false, status: 500, error: '500 boom' }] });
    alerts.subscribe('u1', subscription(1));
    alerts.subscribe('u1', subscription(2));

    expect((await alerts.create({ title: 'x', origin: api })).pushedTo).toBe(0);
    const devices = alerts.pushStatus().devices;
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ id: deviceId('https://push.example/device-2'), lastError: '500 boom', service: 'push.example' });
  });

  it('suscribirse otra vez actualiza el mínimo sin duplicar, y se puede quitar por id', () => {
    const { alerts } = setup();
    alerts.subscribe('u1', subscription(1));
    const again = alerts.subscribe('u1', subscription(1, 'critical'));
    expect(alerts.pushStatus().devices).toHaveLength(1);
    expect(again.minImportance).toBe('critical');
    expect(alerts.unsubscribe({ id: again.id })).toBe(true);
    expect(alerts.pushStatus().devices).toHaveLength(0);
  });

  it('genera el par VAPID una vez y lo conserva', () => {
    const { alerts, db } = setup();
    const first = alerts.pushStatus().publicKey;
    const again = new AlertService({ db, clock: fixedClock(NOW), pushSubject: 'mailto:x@y.es', apiPerMinute: 1, retentionDays: 1, maxStored: 1 });
    expect(again.pushStatus().publicKey).toBe(first);
    expect(Buffer.from(first, 'base64url')).toHaveLength(65);
  });
});

describe('lo que cuenta Jarvis', () => {
  const run = (patch: Partial<Run>): Run => ({
    id: 'r1', workspaceId: 'w1', provider: 'claude', executionHost: 'goro2', status: 'completed',
    promptPreview: 'arregla el login', resultSummary: 'Hecho: 3 ficheros', errorMessage: null, errorCode: null,
    ...patch,
  }) as Run;

  it('un trabajo que termina avisa con su máquina, su agente y el enlace al trabajo', async () => {
    const { alerts } = setup();
    runAlert(run({}), 'Login roto', alerts);
    runAlert(run({ id: 'r2', status: 'failed', errorMessage: 'exit 1' }), null, alerts);
    runAlert(run({ id: 'r3', status: 'cancelled' }), null, alerts);
    await alerts.settle();

    const [cancelled, failed, done] = alerts.list().alerts;
    expect(done).toMatchObject({ title: 'Terminó: Login roto', body: 'Hecho: 3 ficheros', importance: 'normal', link: '/runs/r1',
      origin: { kind: 'jarvis', host: 'goro2', app: 'runs/claude' } });
    expect(failed).toMatchObject({ title: 'Falló: arregla el login', body: 'exit 1', importance: 'high' });
    expect(cancelled).toMatchObject({ importance: 'low' });
  });

  it('la salud avisa al confirmar un cambio, no en la primera vuelta ni por un fallo suelto', async () => {
    const { alerts } = setup();
    let hostStatus: 'ok' | 'failed' = 'failed';
    const health = (): Promise<Health> => Promise.resolve({
      status: 'ok', service: 'jarvis-core', version: 't', at: NOW,
      checks: { 'ssh:goro2': { status: hostStatus, message: 'timeout' }, database: { status: 'ok' } },
    });
    const watch = new HealthWatch({ snapshot: health, alerts, host: 'zeus', intervalMs: 0 });

    await watch.tick(); // aprende: goro2 ya estaba caído al arrancar
    await watch.tick();
    expect(alerts.list().alerts).toHaveLength(0);

    hostStatus = 'ok';
    await watch.tick(); // una vez bien: todavía no
    expect(alerts.list().alerts).toHaveLength(0);
    await watch.tick();
    expect(alerts.list().alerts[0]).toMatchObject({ title: 'goro2 vuelve a responder', importance: 'low' });

    hostStatus = 'failed';
    await watch.tick();
    await watch.tick();
    await watch.tick();
    await alerts.settle();
    const titles = alerts.list().alerts.map((a) => `${a.importance}:${a.title}`);
    expect(titles).toEqual(['high:goro2 no responde', 'low:goro2 vuelve a responder']);
    expect(alerts.list().alerts[0]?.origin).toEqual({ kind: 'jarvis', host: 'zeus', app: 'salud' });
  });
});

describe('las rutas', () => {
  let close: (() => void) | null = null;
  afterEach(() => { close?.(); close = null; });

  function app() {
    const db = openDatabase({ path: ':memory:', skipVersionCheck: true });
    const services = buildServices({ db, config: { alertsHealthWatchMs: 0 } });
    close = () => services.close();
    return buildApp({ services, trustAllIdentities: true });
  }

  it('por la API el origen es siempre api, con la máquina declarada y la IP que vio el gateway', async () => {
    const server = app();
    const created = await server.inject({
      method: 'POST', url: '/api/alerts',
      headers: { 'x-jarvis-client-ip': '192.168.1.42' },
      payload: { title: 'Backup hecho', importance: 'high', host: 'braian', app: 'backup', link: '/health' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ title: 'Backup hecho', importance: 'high', origin: { kind: 'api', host: 'braian', app: 'backup' }, pushedTo: 0 });

    // Sin máquina declarada, la IP la sustituye; y `kind` no se puede declarar.
    const anonymous = await server.inject({ method: 'POST', url: '/api/alerts', headers: { 'x-jarvis-client-ip': '10.0.0.9' }, payload: { title: 'x' } });
    expect(anonymous.json()).toMatchObject({ origin: { kind: 'api', host: '10.0.0.9', app: null } });
    const forged = await server.inject({ method: 'POST', url: '/api/alerts', payload: { title: 'x', kind: 'jarvis' } });
    expect(forged.statusCode).toBe(400);
    const empty = await server.inject({ method: 'POST', url: '/api/alerts', payload: { title: '' } });
    expect(empty.statusCode).toBe(400);
    const badLevel = await server.inject({ method: 'POST', url: '/api/alerts', payload: { title: 'x', importance: 'urgente' } });
    expect(badLevel.statusCode).toBe(400);

    const list = await server.inject({ method: 'GET', url: '/api/alerts?importance=high' });
    expect(list.json<{ alerts: Array<{ title: string }>; unread: number }>()).toMatchObject({ unread: 2, alerts: [{ title: 'Backup hecho' }] });
    const id = (created.json() as { id: string }).id;
    expect((await server.inject({ method: 'POST', url: '/api/alerts/read', payload: { ids: [id] } })).json()).toEqual({ updated: 1 });
    expect((await server.inject({ method: 'DELETE', url: `/api/alerts/${id}` })).statusCode).toBe(204);
    expect((await server.inject({ method: 'DELETE', url: `/api/alerts/${id}` })).statusCode).toBe(404);
  });

  it('expone la clave pública y registra dispositivos', async () => {
    const server = app();
    const status = await server.inject({ method: 'GET', url: '/api/alerts/push' });
    expect(status.json<{ publicKey: string }>().publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    const device = await server.inject({ method: 'POST', url: '/api/alerts/push/subscriptions', payload: subscription(1) });
    expect(device.statusCode).toBe(201);
    const bad = await server.inject({ method: 'POST', url: '/api/alerts/push/subscriptions', payload: { endpoint: 'http://no-https', keys: {} } });
    expect(bad.statusCode).toBe(400);
    expect((await server.inject({ method: 'POST', url: '/api/alerts/push/unsubscribe', payload: { endpoint: subscription(1).endpoint } })).statusCode).toBe(204);
    expect((await server.inject({ method: 'GET', url: '/api/alerts/push' })).json<{ devices: unknown[] }>().devices).toEqual([]);
  });
});
