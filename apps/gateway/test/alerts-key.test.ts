/**
 * La clave de la API de alertas: abre una sola puerta, y nada más.
 *
 * Lo que se fija es la dirección en la que cae cada caso dudoso: una clave mala es 401 aunque la
 * petición traiga cookie o venga de la LAN con el modo de pruebas puesto; una clave buena no sirve
 * para leer la bandeja ni para ninguna otra ruta; y la IP que llega al core es la que vio el
 * gateway, no la que el cliente diga.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const KEY = 'ja_test_0123456789abcdefghijklmnopqrstuvwxyz';

let app: FastifyInstance;
let core: Server;
let port = 0;
let seen: Array<{ method: string; url: string; identity: { userId: string; username: string } | null; ip: string | undefined; auth: string | undefined }> = [];
let config: typeof import('../src/config.js')['config'];
let resetLimiters: () => void;

const identityOf = (req: IncomingMessage) => {
  const token = req.headers['x-jarvis-identity'];
  if (typeof token !== 'string') return null;
  return JSON.parse(Buffer.from(token.split('.')[0] as string, 'base64url').toString()) as { userId: string; username: string };
};

beforeAll(async () => {
  core = createServer((req, res) => {
    seen.push({
      method: req.method ?? '', url: req.url ?? '', identity: identityOf(req),
      ip: req.headers['x-jarvis-client-ip'] as string | undefined, auth: req.headers.authorization,
    });
    req.resume();
    req.on('end', () => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"id":"al1"}');
    });
  });
  await new Promise<void>((resolve) => core.listen(0, '127.0.0.1', () => resolve()));
  process.env['JARVIS_CORE_URL'] = `http://127.0.0.1:${(core.address() as AddressInfo).port}`;
  process.env['JARVIS_ALERTS_API_KEY'] = `otra-clave-vieja-de-rotacion-123456, ${KEY}`;

  vi.resetModules();
  ({ config } = await import('../src/config.js'));
  ({ resetLimitersForTests: resetLimiters } = await import('../src/lib/ratelimit.js'));
  const { buildGateway } = await import('../src/app.js');
  app = buildGateway();
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
});

afterAll(async () => {
  delete process.env['JARVIS_ALERTS_API_KEY'];
  await app.close();
  await new Promise<void>((resolve) => core.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
  resetLimiters();
  config.testNoAuth = false;
});

const send = (path: string, { method = 'POST', key = KEY, headers = {} }: { method?: string; key?: string | null; headers?: Record<string, string> } = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
    ...(method === 'POST' ? { body: JSON.stringify({ title: 'hola' }) } : {}),
  });

describe('POST /api/alerts con la clave', () => {
  it('entra como el usuario de servicio, sin la clave y con la IP que vio el gateway', async () => {
    const response = await send('/api/alerts', { headers: { 'x-jarvis-client-ip': '6.6.6.6' } });

    expect(response.status).toBe(201);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/api/alerts', identity: { userId: 'svc:alerts-api', username: 'alerts-api' }, ip: '127.0.0.1' });
    // La credencial se queda en este salto: el core no la ve nunca.
    expect(seen[0]?.auth).toBeUndefined();
  });

  it('acepta cualquiera de las claves configuradas, para poder rotar', async () => {
    expect((await send('/api/alerts', { key: 'otra-clave-vieja-de-rotacion-123456' })).status).toBe(201);
  });

  it('una clave mala es 401 aunque el modo de pruebas deje entrar sin nada', async () => {
    config.testNoAuth = true;
    const response = await send('/api/alerts', { key: 'mala' });
    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('la clave no sirve para leer la bandeja ni para ninguna otra ruta', async () => {
    expect((await send('/api/alerts', { method: 'GET' })).status).toBe(403);
    expect((await send('/api/health', { method: 'GET' })).status).toBe(401);
    expect((await send('/api/alerts/read')).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('tras muchos intentos fallidos desde la misma IP, corta con 429', async () => {
    for (let i = 0; i < 10; i += 1) expect((await send('/api/alerts', { key: `mala-${i}` })).status).toBe(401);
    const blocked = await send('/api/alerts', { key: 'mala-otra-vez' });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toMatch(/^\d+$/);
  });

  it('sin clave configurada, la puerta está cerrada y lo dice', async () => {
    const keys = config.alertsApiKeys;
    (config as { alertsApiKeys: string[] }).alertsApiKeys = [];
    try {
      const response = await send('/api/alerts');
      expect(response.status).toBe(401);
      expect((await response.json() as { error: { message: string } }).error.message).toMatch(/JARVIS_ALERTS_API_KEY/);
    } finally {
      (config as { alertsApiKeys: string[] }).alertsApiKeys = keys;
    }
  });
});
