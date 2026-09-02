/**
 * SSE reanudable, el límite de confianza gateway→core y el ciclo de un adjunto.
 *
 * Aquí el core escucha en un puerto de verdad: `inject` no sirve para probar un stream que debe
 * sobrevivir a una desconexión.
 */
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeSessionIndex, fakeSshPath, indexRow, waitFor } from '@jarvis/testkit';
import { defaultSshConfig, sshExec } from '@jarvis/agent-adapters';
import type { Run } from '@jarvis/contracts';
import { buildApp } from '../../apps/core/src/app.js';
import { buildServices, type CoreServices } from '../../apps/core/src/services.js';
import { openDatabase } from '../../apps/core/src/platform/db.js';

const root = mkdtempSync(join(tmpdir(), 'jarvis-sse-'));
process.env['JARVIS_FAKE_SSH_ROOT'] = join(root, 'fake-ssh');

const INTERNAL_SECRET = process.env['JARVIS_INTERNAL_SECRET'] as string;
const index = new FakeSessionIndex([indexRow()]);

let services: CoreServices;
let baseUrl: string;
let app: ReturnType<typeof buildApp>;

/** Firma como lo haría el gateway. Si esto no coincide, el core debe rechazar la petición. */
function identityHeader(user = { userId: 'u1', username: 'braian' }, ttlSeconds = 60): string {
  const payload = { ...user, requestId: 'req_test', exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', Buffer.from(INTERNAL_SECRET, 'utf8')).update(body).digest('base64url');
  return `${body}.${mac}`;
}

const authed = (extra: Record<string, string> = {}): Record<string, string> =>
  ({ 'x-jarvis-identity': identityHeader(), 'content-type': 'application/json', ...extra });

beforeAll(async () => {
  services = buildServices({
    db: openDatabase({ path: join(root, 'core.db') }),
    index: index as never,
    config: {
      hosts: ['bastion'],
      bastionHost: 'bastion',
      sshCommand: fakeSshPath(),
      knownHostsFile: '',
      spoolRoot: join(root, 'spool'),
      attachmentRoot: join(root, 'attachments'),
      pollIntervalMs: 200,
      internalSecret: INTERNAL_SECRET,
    },
  });
  app = buildApp({ services, logger: process.env['JARVIS_DEBUG'] === '1' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  baseUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : '';
  await services.supervisor.start();
});

afterAll(async () => {
  services.supervisor.stop();
  await app.close();
  services.close();
  const config = defaultSshConfig({ sshCommand: fakeSshPath(), hosts: ['bastion'], knownHostsFile: '' });
  await sshExec({ host: 'bastion', command: 'tmux kill-server 2>/dev/null || true', config }).catch(() => undefined);
  rmSync(root, { recursive: true, force: true });
});

async function openWorkspace(sessionId = 'sid-1'): Promise<string> {
  const response = await fetch(`${baseUrl}/api/workspaces`, {
    method: 'POST',
    headers: authed(),
    body: JSON.stringify({ ref: { host: 'bastion', provider: 'claude', sessionId } }),
  });
  const body = await response.json() as { workspace: { id: string } };
  return body.workspace.id;
}

async function createRun(workspaceId: string, prompt: string): Promise<Run> {
  const response = await fetch(`${baseUrl}/api/runs`, {
    method: 'POST', headers: authed(), body: JSON.stringify({ workspaceId, prompt }),
  });
  return (await response.json() as { run: Run }).run;
}

/** Lee un stream SSE hasta que el predicado se cumple o vence el plazo. */
async function readSse(url: string, headers: Record<string, string>, until: (events: Array<{ id: string; data: string }>) => boolean, timeoutMs = 25_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(url, { headers, signal: controller.signal });
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const events: Array<{ id: string; data: string }> = [];
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n\n');
      while (index !== -1) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const id = /^id: (.*)$/m.exec(block)?.[1] ?? '';
        const data = /^data: (.*)$/m.exec(block)?.[1] ?? '';
        // Los bloques sin `id` (run.ended, keepalive) no son eventos del log.
        if (data && id) events.push({ id, data });
        index = buffer.indexOf('\n\n');
      }
      if (until(events)) break;
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return events;
}

describe('EDGE-PROXY-01 · el límite de confianza', () => {
  it('sin identidad firmada el core no atiende nada', async () => {
    const response = await fetch(`${baseUrl}/api/hosts`);
    expect(response.status).toBe(401);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('UNAUTHENTICATED');
  });

  it('una firma inválida o caducada tampoco vale', async () => {
    const tampered = `${identityHeader().split('.')[0]}.otracosa`;
    expect((await fetch(`${baseUrl}/api/hosts`, { headers: { 'x-jarvis-identity': tampered } })).status).toBe(401);
    const expired = identityHeader({ userId: 'u1', username: 'braian' }, -10);
    expect((await fetch(`${baseUrl}/api/hosts`, { headers: { 'x-jarvis-identity': expired } })).status).toBe(401);
  });

  it('el healthcheck interno no exige firma, y no cuenta nada más', async () => {
    const response = await fetch(`${baseUrl}/internal/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: 'jarvis-core' });
  });

  it('con firma válida se atiende y la identidad viaja a la auditoría', async () => {
    const workspaceId = await openWorkspace('sid-audit');
    const entry = services.audit.recent(5).find((row) => row['workspace_id'] === workspaceId);
    expect(entry?.['actor_user']).toBe('braian');
  });
});

describe('RUN-SSE-01 · replay exacto', () => {
  it('Last-Event-ID reanuda desde el seq exacto, sin repetir ni saltarse nada', async () => {
    const workspaceId = await openWorkspace();
    const run = await createRun(workspaceId, '@@slow:6 cuenta despacio');

    // Primer cliente: se desconecta a mitad, como haría un móvil que pierde cobertura.
    const first = await readSse(`${baseUrl}/events/runs/${run.id}`, authed(), (events) => events.length >= 4);
    expect(first.length).toBeGreaterThanOrEqual(4);
    const lastSeen = Number(first.at(-1)?.id);

    // Segundo cliente: dice por dónde iba y el servidor manda estrictamente lo siguiente.
    const resumed = await readSse(
      `${baseUrl}/events/runs/${run.id}`,
      authed({ 'last-event-id': String(lastSeen) }),
      (events) => events.some((event) => event.data.includes('"status"') && event.data.includes('completed')),
    );
    const resumedSeqs = resumed.map((event) => Number(event.id)).filter((seq) => Number.isFinite(seq));
    expect(Math.min(...resumedSeqs)).toBe(lastSeen + 1);
    expect(new Set(resumedSeqs).size).toBe(resumedSeqs.length);

    // Unir las dos mitades reconstruye la secuencia entera sin huecos.
    const all = [...first.map((event) => Number(event.id)), ...resumedSeqs].filter((seq) => Number.isFinite(seq));
    const unique = [...new Set(all)].sort((a, b) => a - b);
    expect(unique).toEqual(unique.map((_, index) => index));

    const finished = await waitFor(
      async () => (await (await fetch(`${baseUrl}/api/runs/${run.id}`, { headers: authed() })).json() as { run: Run }).run,
      (value) => value.status === 'completed',
      { what: 'el run del SSE' },
    );
    expect(finished.status).toBe('completed');
  });

  it('desconectar el stream no toca el run: sigue y termina igual', async () => {
    const workspaceId = await openWorkspace();
    const run = await createRun(workspaceId, '@@slow:4 sigue sin mí');
    await readSse(`${baseUrl}/events/runs/${run.id}`, authed(), (events) => events.length >= 2);
    // El lector se fue; el run no se entera.
    const finished = await waitFor(
      async () => (await (await fetch(`${baseUrl}/api/runs/${run.id}`, { headers: authed() })).json() as { run: Run }).run,
      (value) => value.status === 'completed',
      { what: 'que termine sin oyentes' },
    );
    expect(finished.resultOk).toBe(true);
  });
});

describe('ATTACH-01 · ciclo de vida de un adjunto', () => {
  it('se sube, se reclama en un run y se libera al terminar', async () => {
    const workspaceId = await openWorkspace('sid-attach');
    const payload = Buffer.from('registro de errores del 1 de septiembre\n'.repeat(50));

    const uploaded = await fetch(`${baseUrl}/api/attachments?workspaceId=${workspaceId}&name=errores.log&type=text/plain`, {
      method: 'POST',
      headers: { 'x-jarvis-identity': identityHeader(), 'content-type': 'application/octet-stream', 'content-length': String(payload.length) },
      body: payload,
      duplex: 'half',
    } as RequestInit);
    expect(uploaded.status).toBe(201);
    const { attachment } = await uploaded.json() as { attachment: { id: string; remotePath: string; state: string; displayName: string } };
    expect(attachment.state).toBe('staged');
    // El path lo pone Jarvis: el nombre del usuario es sólo una etiqueta.
    expect(attachment.remotePath).not.toContain('errores.log');
    expect(attachment.displayName).toBe('errores.log');

    const response = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST', headers: authed(),
      body: JSON.stringify({ workspaceId, prompt: 'mira el adjunto', attachmentIds: [attachment.id] }),
    });
    expect(response.status).toBe(202);
    const { run } = await response.json() as { run: Run };

    await waitFor(
      async () => (await (await fetch(`${baseUrl}/api/runs/${run.id}`, { headers: authed() })).json() as { run: Run }).run,
      (value) => value.status === 'completed',
      { what: 'el run con adjunto' },
    );

    const after = await waitFor(
      async () => (await (await fetch(`${baseUrl}/api/attachments/${attachment.id}`, { headers: authed() })).json() as { attachment: { state: string } }).attachment,
      (value) => value.state === 'released',
      { what: 'que se libere el adjunto' },
    );
    expect(after.state).toBe('released');
  });

  it('un adjunto ya usado no se puede reclamar otra vez, ni sirve para otra persona', async () => {
    const workspaceId = await openWorkspace('sid-attach-2');
    const payload = Buffer.from('una vez');
    const uploaded = await fetch(`${baseUrl}/api/attachments?workspaceId=${workspaceId}&name=a.txt`, {
      method: 'POST',
      headers: {
        'x-jarvis-identity': identityHeader(),
        'content-type': 'text/plain',
        'content-length': String(payload.length),
      },
      body: payload,
      duplex: 'half',
    } as RequestInit);
    const { attachment } = await uploaded.json() as { attachment: { id: string } };

    const first = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST', headers: authed(),
      body: JSON.stringify({ workspaceId, prompt: 'primero', attachmentIds: [attachment.id] }),
    });
    expect(first.status).toBe(202);

    // El mismo adjunto en un segundo run: se usa una vez y sólo una.
    const second = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST', headers: authed(),
      body: JSON.stringify({ workspaceId, prompt: 'segundo', attachmentIds: [attachment.id] }),
    });
    expect(second.status).toBe(409);
    expect((await second.json() as { error: { code: string } }).error.code).toBe('CONFLICT');

    // Y un adjunto de otra persona tampoco entra, aunque se conozca su id.
    const otherIdentity = (() => {
      const body = Buffer.from(JSON.stringify({
        userId: 'u2', username: 'otra', requestId: 'req_test', exp: Math.floor(Date.now() / 1000) + 60,
      })).toString('base64url');
      const mac = createHmac('sha256', Buffer.from(INTERNAL_SECRET, 'utf8')).update(body).digest('base64url');
      return `${body}.${mac}`;
    })();
    const third = await fetch(`${baseUrl}/api/runs`, {
      method: 'POST',
      headers: { 'x-jarvis-identity': otherIdentity, 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId, prompt: 'ajeno', attachmentIds: [attachment.id] }),
    });
    expect([403, 409]).toContain(third.status);
  });

  it('sin Content-Length no se acepta: la cuota se reserva antes de leer un byte', async () => {
    const workspaceId = await openWorkspace('sid-attach-3');
    const response = await fetch(`${baseUrl}/api/attachments?workspaceId=${workspaceId}&name=b.txt`, {
      method: 'POST',
      headers: { 'x-jarvis-identity': identityHeader(), 'content-type': 'application/octet-stream' },
      // Un stream sin longitud declarada viaja como chunked.
      body: Readable.toWeb(Readable.from([Buffer.from('sin longitud declarada')])) as ReadableStream,
      duplex: 'half',
    } as RequestInit);
    expect(response.status).toBe(400);
    expect((await response.json() as { error: { code: string } }).error.code).toBe('BAD_REQUEST');
  });
});

describe('INDEX-FRESH-01 · el índice viejo sigue sirviendo', () => {
  it('cuando el índice falla se conserva lo último bueno y se dice que está viejo', async () => {
    const first = await fetch(`${baseUrl}/api/sessions`, { headers: authed() });
    const before = await first.json() as { sessions: unknown[]; stale: boolean };
    expect(before.sessions.length).toBeGreaterThan(0);
    expect(before.stale).toBe(false);

    index.failWith = 'the index is down';
    const second = await fetch(`${baseUrl}/api/sessions`, { headers: authed() });
    const after = await second.json() as { sessions: unknown[]; stale: boolean; freshness: Array<{ status: string; error: string }> };
    expect(second.status).toBe(200);
    expect(after.sessions.length).toBe(before.sessions.length);
    expect(after.stale).toBe(true);
    expect(after.freshness[0]?.status).toBe('failed');
    expect(after.freshness[0]?.error).toContain('down');

    // Y la salud lo cuenta por dependencia, sin declarar caída toda la aplicación.
    const health = await (await fetch(`${baseUrl}/api/health?hosts=skip`, { headers: authed() })).json() as {
      status: string; checks: Record<string, { status: string }>;
    };
    expect(health.status).toBe('degraded');
    expect(health.checks['aisessions']?.status).not.toBe('ok');
    expect(health.checks['database']?.status).toBe('ok');
    index.failWith = null;
  });
});
