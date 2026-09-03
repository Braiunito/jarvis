/**
 * Auditoría del 2026-09-02: N10, N11 y N13.
 *
 * Las tres pruebas están escritas para **fallar con el código anterior**, que es la única forma de
 * saber que prueban algo: sin el arreglo, N10 acumula challenges sin techo, N11 deja que una
 * sesión cerrada vuelva a valer y N13 acepta el upgrade desde cualquier origen.
 */
import { createConnection } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildGateway } from '../src/app.js';
import { config } from '../src/config.js';
import { resetLimitersForTests } from '../src/lib/ratelimit.js';
import { session, SESSION_COOKIE } from '../src/lib/session.js';
import { users, type User } from '../src/lib/store.js';
import { liveChallengesForTests, resetChallengesForTests } from '../src/routes/auth.js';

const app = buildGateway();
const revokedFile = (): string => join(config.dataDir, 'revoked-sessions.json');
const esRoot = (): boolean => process.getuid?.() === 0;

let user: User;
let topes: { perIp: number; total: number };

beforeEach(() => {
  resetLimitersForTests();
  resetChallengesForTests();
  session.resetRevokedForTests();
  for (const existing of users.list()) users.remove(existing.username);
  user = users.create({ username: 'braian', displayName: 'Braian' });
  topes = { perIp: config.challengeMaxPerIp, total: config.challengeMaxTotal };
  mkdirSync(config.dataDir, { recursive: true });
  if (existsSync(revokedFile())) writeFileSync(revokedFile(), '{}');
});

afterEach(() => {
  Object.assign(config, { challengeMaxPerIp: topes.perIp, challengeMaxTotal: topes.total });
  chmodSync(config.dataDir, 0o700);
});

const options = async (payload: unknown = {}) =>
  app.inject({ method: 'POST', url: '/auth/passkey/options', payload: payload as object });

describe('N10 · emitir challenges deja de ser gratis', () => {
  it('pedir muchos desde la misma dirección no acumula más del tope', async () => {
    for (let i = 0; i < 40; i += 1) {
      const response = await options({ username: `quien-sea-${i}` });
      expect(response.statusCode).toBe(200);
    }
    // Sin el arreglo aquí había 40 entradas vivas, y nada impedía seguir.
    expect(liveChallengesForTests()).toBeLessThanOrEqual(config.challengeMaxPerIp);
  });

  it('el último pedido sigue sirviendo: se tiran los viejos, no el de quien está entrando', async () => {
    for (let i = 0; i < 10; i += 1) await options({});
    const ultimo = await options({});
    const { challengeId } = ultimo.json() as { challengeId: string };
    expect(challengeId).toBeTruthy();
    // Sigue vivo: la verificación falla por la firma, no porque el challenge se haya perdido.
    const verificado = await app.inject({
      method: 'POST', url: '/auth/passkey/verify',
      payload: { challengeId, credential: { id: 'x', rawId: 'x', response: {}, type: 'public-key' } },
    });
    expect(verificado.statusCode).not.toBe(404);
  });

  it('cuando no cabe ni uno más se contesta 429, no se calla y guarda', async () => {
    Object.assign(config, { challengeMaxTotal: 3, challengeMaxPerIp: 100 });
    for (let i = 0; i < 3; i += 1) expect((await options({})).statusCode).toBe(200);

    const lleno = await options({});
    expect(lleno.statusCode).toBe(429);
    expect(lleno.headers['retry-after']).toBeTruthy();
    expect(liveChallengesForTests()).toBeLessThanOrEqual(3);
  });
});

describe('N11 · una sesión cerrada no vuelve sola', () => {
  it('si la lista de revocación se corrompe, lo anterior deja de valer', () => {
    const token = session.issue(user);
    expect(session.read(token)).not.toBeNull();
    expect(session.revoke(token)).toBe(true);
    expect(session.read(token)).toBeNull();

    // Alguien corrompe el fichero y el proceso se reinicia.
    writeFileSync(revokedFile(), '{esto no es json');
    session.resetRevokedForTests();

    // Con el código anterior la lista se sustituía por una vacía y esto devolvía los claims.
    expect(session.read(token)).toBeNull();
  });

  it('el fichero roto se aparta en vez de sobrescribirse, para poder mirarlo', () => {
    session.revoke(session.issue(user));
    writeFileSync(revokedFile(), 'roto del todo');
    session.resetRevokedForTests();
    session.read(session.issue(user));

    const apartados = readFileSync(revokedFile(), 'utf8');
    expect(apartados).not.toContain('roto del todo');
    expect(JSON.parse(apartados)).toHaveProperty('revokedBefore');
  });

  it('entrar de nuevo funciona: se invalida lo anterior, no el futuro', async () => {
    writeFileSync(revokedFile(), 'roto');
    session.resetRevokedForTests();
    session.read(session.issue(user)); // dispara la detección y fija la marca

    await new Promise((resolve) => setTimeout(resolve, 1100));
    const nueva = session.issue(user);
    expect(session.read(nueva)).not.toBeNull();
  });

  it.skipIf(esRoot())('logout no dice que sí cuando no puede revocar', async () => {
    const token = session.issue(user);
    // El directorio de datos deja de admitir escrituras: es lo que pasa con el disco lleno.
    chmodSync(config.dataDir, 0o500);

    const response = await app.inject({
      method: 'POST', url: '/auth/logout',
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });

    // Con el código anterior esto era 200 {ok:true} y la persona se iba convencida.
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ ok: false });
    expect(String(response.headers['set-cookie'])).toContain(`${SESSION_COOKIE}=`);
  });
});

describe('N13 · el WebSocket comprueba de dónde viene', () => {
  const handshake = (headers: string[]): Promise<string> => new Promise((resolve, reject) => {
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      socket.write([
        'GET /events/terminal?host=bastion&name=x HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        ...headers,
        '', '',
      ].join('\r\n'));
    });
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (data.includes('\r\n')) { socket.destroy(); resolve(data); }
    });
    socket.on('error', reject);
    socket.setTimeout(5000, () => { socket.destroy(); resolve(data || 'sin respuesta'); });
  });

  // Se levanta una vez para todo el bloque: Fastify no se puede reabrir después de cerrarlo, y
  // el upgrade sólo existe sobre un servidor escuchando de verdad.
  beforeAll(async () => { await app.listen({ port: 0, host: '127.0.0.1' }); });
  afterAll(async () => { await app.close(); });

  it('un origen que no está en la lista se rechaza con 403', async () => {
    const cookie = `${SESSION_COOKIE}=${session.issue(user)}`;
    const respuesta = await handshake([`Cookie: ${cookie}`, 'Origin: https://sitio-de-otro.example']);
    // Sin el arreglo, con cookie válida esto llegaba al core y abría la terminal.
    expect(respuesta).toContain('403');
  });

  it('sin Origin también se rechaza: si bastara con omitirlo, no serviría de nada', async () => {
    const cookie = `${SESSION_COOKIE}=${session.issue(user)}`;
    const respuesta = await handshake([`Cookie: ${cookie}`]);
    expect(respuesta).toContain('403');
  });

  it('el origen bueno pasa la comprobación y sigue su camino', async () => {
    const cookie = `${SESSION_COOKIE}=${session.issue(user)}`;
    const respuesta = await handshake([`Cookie: ${cookie}`, `Origin: ${config.origins[0]}`]);
    // No llega a 101 porque no hay core detrás en esta prueba; lo que importa es que no es 403.
    expect(respuesta).not.toContain('403');
  });

  it('el origen se mira antes que la sesión: sin cookie y mal origen, también 403', async () => {
    const respuesta = await handshake(['Origin: https://sitio-de-otro.example']);
    expect(respuesta).toContain('403');
  });
});
