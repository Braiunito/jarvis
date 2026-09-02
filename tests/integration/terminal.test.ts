/**
 * Gate M4 (terminal): la tmux es la continuidad, el WebSocket es transporte.
 *
 * Se prueba contra tmux de verdad a través del ssh falso: abrir, escribir, desconectar sin matar
 * nada y volver a engancharse a la misma sesión.
 */
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeSessionIndex, fakeSshPath, indexRow, sleep, waitFor } from '@jarvis/testkit';
import { defaultSshConfig, sshExec } from '@jarvis/agent-adapters';
import type { TerminalSession } from '@jarvis/contracts';
import { buildApp } from '../../apps/core/src/app.js';
import { buildServices, type CoreServices } from '../../apps/core/src/services.js';
import { openDatabase } from '../../apps/core/src/platform/db.js';

const root = mkdtempSync(join(tmpdir(), 'jarvis-term-'));
process.env['JARVIS_FAKE_SSH_ROOT'] = join(root, 'fake-ssh');
const INTERNAL_SECRET = process.env['JARVIS_INTERNAL_SECRET'] as string;

let services: CoreServices;
let app: ReturnType<typeof buildApp>;
let baseUrl: string;
let wsBase: string;

function identityHeader(): string {
  const payload = { userId: 'u1', username: 'braian', requestId: 'req_term', exp: Math.floor(Date.now() / 1000) + 300 };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', Buffer.from(INTERNAL_SECRET, 'utf8')).update(body).digest('base64url');
  return `${body}.${mac}`;
}

const authed = (): Record<string, string> =>
  ({ 'x-jarvis-identity': identityHeader(), 'content-type': 'application/json' });

beforeAll(async () => {
  services = buildServices({
    db: openDatabase({ path: join(root, 'core.db') }),
    index: new FakeSessionIndex([indexRow()]) as never,
    config: {
      hosts: ['bastion', 'serverC'],
      bastionHost: 'bastion',
      sshCommand: fakeSshPath(),
      knownHostsFile: '',
      spoolRoot: join(root, 'spool'),
      internalSecret: INTERNAL_SECRET,
    },
  });
  app = buildApp({ services });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
});

afterAll(async () => {
  await app.close();
  services.close();
  const config = defaultSshConfig({ sshCommand: fakeSshPath(), hosts: ['bastion'], knownHostsFile: '' });
  await sshExec({ host: 'bastion', command: 'tmux kill-server 2>/dev/null || true', config }).catch(() => undefined);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
});

/** Un cliente WebSocket que junta lo recibido, para poder afirmar sobre el TTY. */
async function connect(name: string, host = 'bastion') {
  const socket = new WebSocket(`${wsBase}/events/terminal?host=${host}&name=${name}&cols=100&rows=30`, {
    headers: { 'x-jarvis-identity': identityHeader() },
  } as unknown as string[]);
  const chunks: string[] = [];
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('message', (event) => {
    chunks.push(typeof event.data === 'string'
      ? event.data
      : Buffer.from(event.data as ArrayBuffer).toString('utf8'));
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('no se pudo abrir el WebSocket')), { once: true });
  });
  return {
    socket,
    text: () => chunks.join(''),
    send: (data: string) => socket.send(data),
    close: () => socket.close(),
  };
}

describe('TERM-TMUX-01 · abrir y listar', () => {
  it('abrir es idempotente y distingue una sesión de run de una interactiva', async () => {
    const first = await fetch(`${baseUrl}/api/terminal/open`, {
      method: 'POST', headers: authed(),
      body: JSON.stringify({ host: 'bastion', provider: 'claude', sessionId: 'sid-1' }),
    });
    expect(first.status).toBe(200);
    const opened = await first.json() as { name: string; created: boolean };
    expect(opened.created).toBe(true);
    expect(opened.name).toMatch(/^jarvis-claude-sid-1$/);

    const second = await (await fetch(`${baseUrl}/api/terminal/open`, {
      method: 'POST', headers: authed(),
      body: JSON.stringify({ host: 'bastion', provider: 'claude', sessionId: 'sid-1' }),
    })).json() as { name: string; created: boolean };
    expect(second.created).toBe(false);
    expect(second.name).toBe(opened.name);

    const listed = await (await fetch(`${baseUrl}/api/terminal/sessions?host=bastion`, { headers: authed() }))
      .json() as { sessions: TerminalSession[] };
    const session = listed.sessions.find((candidate) => candidate.name === opened.name);
    expect(session?.kind).toBe('interactive');
  });

  it('un host sin tmux lo dice en vez de fallar de forma rara', async () => {
    const response = await fetch(`${baseUrl}/api/terminal/open`, {
      method: 'POST', headers: authed(),
      body: JSON.stringify({ host: 'serverC', provider: 'claude' }),
    });
    expect(response.status).toBe(409);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('TMUX_MISSING');
  });

  it('no se puede tocar una sesión que no creó Jarvis', async () => {
    const response = await fetch(`${baseUrl}/api/terminal/destroy`, {
      method: 'POST', headers: authed(),
      body: JSON.stringify({ host: 'bastion', name: 'sesion-de-otro' }),
    });
    expect(response.status).toBe(403);
  });
});

describe('TERM-WS-01 · el socket es transporte, no continuidad', () => {
  it('adjunta, recibe el TTY, acepta entrada y al desconectar no mata la sesión', async () => {
    const opened = await (await fetch(`${baseUrl}/api/terminal/open`, {
      method: 'POST', headers: authed(),
      body: JSON.stringify({ host: 'bastion', provider: 'claude', sessionId: 'sid-ws' }),
    })).json() as { name: string };

    const client = await connect(opened.name);
    // Se exige el banner del agente: cualquier byte también lo produce un error de attach, y eso
    // es justo lo que este test debe distinguir.
    const banner = await waitFor(() => client.text(), (text) => text.includes('Claude Code'), {
      what: 'el banner del agente en el TTY',
    });
    expect(banner).not.toContain('not a terminal');

    client.send('hola-terminal\r');
    // El TTY hace eco de lo que se teclea: es la prueba de que la entrada llega al otro lado.
    await waitFor(() => client.text(), (text) => text.includes('hola-terminal'), {
      what: 'el eco de lo tecleado',
    });
    await sleep(300);
    client.close();
    await sleep(300);

    // La sesión sigue ahí después de irse el socket: eso es todo el contrato.
    const listed = await (await fetch(`${baseUrl}/api/terminal/sessions?host=bastion`, { headers: authed() }))
      .json() as { sessions: TerminalSession[] };
    expect(listed.sessions.some((session) => session.name === opened.name)).toBe(true);

    // Y al volver, se engancha a la misma, no se crea otra.
    const again = await connect(opened.name);
    await waitFor(() => again.text(), (text) => text.length > 0, { what: 'el TTY tras reconectar' });
    again.close();

    const afterReconnect = await (await fetch(`${baseUrl}/api/terminal/sessions?host=bastion`, { headers: authed() }))
      .json() as { sessions: TerminalSession[] };
    expect(afterReconnect.sessions.filter((session) => session.name === opened.name)).toHaveLength(1);
  });

  it('destruir sí mata la sesión, y es explícito', async () => {
    const opened = await (await fetch(`${baseUrl}/api/terminal/open`, {
      method: 'POST', headers: authed(),
      body: JSON.stringify({ host: 'bastion', provider: 'claude', sessionId: 'sid-kill' }),
    })).json() as { name: string };

    const response = await fetch(`${baseUrl}/api/terminal/destroy`, {
      method: 'POST', headers: authed(),
      body: JSON.stringify({ host: 'bastion', name: opened.name }),
    });
    expect(response.status).toBe(200);

    const listed = await (await fetch(`${baseUrl}/api/terminal/sessions?host=bastion`, { headers: authed() }))
      .json() as { sessions: TerminalSession[] };
    expect(listed.sessions.some((session) => session.name === opened.name)).toBe(false);
  });

  it('sin identidad firmada el upgrade se rechaza', async () => {
    const socket = new WebSocket(`${wsBase}/events/terminal?host=bastion&name=jarvis-claude-sid-1`);
    const closed = await new Promise<boolean>((resolve) => {
      socket.addEventListener('open', () => resolve(false), { once: true });
      socket.addEventListener('error', () => resolve(true), { once: true });
      socket.addEventListener('close', () => resolve(true), { once: true });
    });
    expect(closed).toBe(true);
  });

  it('un host fuera de la allowlist no se adjunta', async () => {
    const socket = new WebSocket(`${wsBase}/events/terminal?host=elsewhere&name=jarvis-x`, {
      headers: { 'x-jarvis-identity': identityHeader() },
    } as unknown as string[]);
    const rejected = await new Promise<boolean>((resolve) => {
      socket.addEventListener('open', () => resolve(false), { once: true });
      socket.addEventListener('error', () => resolve(true), { once: true });
      socket.addEventListener('close', () => resolve(true), { once: true });
    });
    expect(rejected).toBe(true);
  });
});
