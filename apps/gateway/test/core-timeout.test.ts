/**
 * Auditoría del 2026-09-02, N12: el plazo del core existía en la configuración y no lo usaba nadie.
 *
 * El caso que importa no es «el core no está» —eso ya fallaba rápido— sino «el core acepta la
 * conexión y luego calla»: ahí la petición se quedaba abierta para siempre, consumiendo sockets, y
 * la consola en «cargando» sin nada que la sacara de ahí.
 *
 * Las dos pruebas están escritas para fallar con el código anterior: sin el arreglo, la primera se
 * cuelga hasta que la mata el tiempo límite del propio test.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createConnection } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { User } from '../src/lib/store.js';

/*
 * El core falso escucha en un puerto **efímero**, y el gateway se entera después.
 *
 * Antes ataba el puerto declarado en `JARVIS_CORE_URL` —8770 por defecto—, así que dos corridas
 * de la suite a la vez chocaban con `EADDRINUSE`, el `beforeAll` reventaba y se llevaba el fichero
 * entero por delante. No fallaba un test: no arrancaba ninguno, y la corrida acababa con dos
 * saltados y un total distinto, que es de las formas más confusas de romperse.
 *
 * El orden importa y por eso todo se importa dentro del `beforeAll`: el gateway lee la URL del
 * core **al importarse**, así que primero se ata el puerto, luego se dice dónde está, y sólo
 * entonces se carga el módulo.
 */
let app: FastifyInstance;
let session: typeof import('../src/lib/session.js')['session'];
let SESSION_COOKIE: string;
let config: typeof import('../src/config.js')['config'];

/** Un core que acepta y no contesta nunca. Es el fallo que no se veía. */
let mudo: Server;
let user: User;

/*
 * Se escucha de verdad en vez de usar `inject`: el proxy vive en el servidor HTTP crudo —tuvo que
 * bajar ahí para no consumir el cuerpo antes de reenviarlo— y una petición inyectada no pasa por
 * él, así que acabaría contestando el servidor de estáticos.
 */
let port = 0;

beforeAll(async () => {
  // 1 · El core falso coge el puerto que haya libre.
  mudo = createServer(() => { /* acepta, guarda silencio */ });
  await new Promise<void>((resolve) => mudo.listen(0, '127.0.0.1', () => resolve()));
  const suyo = mudo.address() as AddressInfo;
  process.env['JARVIS_CORE_URL'] = `http://127.0.0.1:${suyo.port}`;

  // 2 · Y el gateway se importa ya sabiendo dónde está.
  vi.resetModules();
  ({ config } = await import('../src/config.js'));
  ({ session, SESSION_COOKIE } = await import('../src/lib/session.js'));
  const { users } = await import('../src/lib/store.js');
  const { buildGateway } = await import('../src/app.js');

  user = users.list()[0] ?? users.create({ username: 'braian', displayName: 'Braian' });
  app = buildGateway();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  port = typeof address === 'object' && address ? address.port : 0;
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve) => mudo.close(() => resolve()));
});

describe('N12 · el core que acepta y calla', () => {
  it('una petición corta con 504 y dice que el core no contestó', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { cookie: `${SESSION_COOKIE}=${session.issue(user)}` },
    });

    expect(response.status).toBe(504);
    const body = await response.json() as { error?: { code?: string; message?: string } };
    expect(body.error?.code).toBe('CORE_TIMEOUT');
    // El mensaje distingue «no llegué» de «llegué y no contestó», que se diagnostican distinto.
    expect(body.error?.message).toContain('did not answer');
  });

  it('un upgrade que no se completa corta con 504 en vez de dejar el socket abierto', async () => {
    const respuesta = await new Promise<string>((resolve, reject) => {
      const socket = createConnection({ port, host: '127.0.0.1' }, () => {
        socket.write([
          'GET /events/terminal?host=bastion&name=jarvis-claude-x HTTP/1.1',
          '127.0.0.1',
          'Upgrade: websocket',
          'Connection: Upgrade',
          'Sec-WebSocket-Version: 13',
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
          `Origin: ${config.origins[0]}`,
          `Cookie: ${SESSION_COOKIE}=${session.issue(user)}`,
          '', '',
        ].join('\r\n').replace('127.0.0.1', 'Host: 127.0.0.1'));
      });
      let data = '';
      socket.on('data', (chunk) => { data += chunk.toString(); });
      socket.on('close', () => resolve(data));
      socket.on('error', reject);
      setTimeout(() => { socket.destroy(); resolve(data); }, 5_000);
    });

    expect(respuesta).toContain('504');
  }, 15_000);
});
