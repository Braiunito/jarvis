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
import { createConnection } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway } from '../src/app.js';
import { config } from '../src/config.js';
import { session, SESSION_COOKIE } from '../src/lib/session.js';
import { users, type User } from '../src/lib/store.js';

const app = buildGateway();
const core = new URL(config.coreUrl);

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
  user = users.list()[0] ?? users.create({ username: 'braian', displayName: 'Braian' });
  mudo = createServer(() => { /* acepta, guarda silencio */ });
  await new Promise<void>((resolve) => mudo.listen(Number(core.port), core.hostname, resolve));
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
