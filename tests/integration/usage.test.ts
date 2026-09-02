/**
 * Cuenta y cuota del agente, contra CLIs de verdad (las falsas del testkit, que se ejecutan).
 *
 * Lo que se prueba es lo que se ve en la cabecera del workspace: de quién es la cuenta, cuánto
 * queda de cada ventana, y que un dato viejo se marca como viejo en vez de desaparecer. El badge
 * dice «restante», así que el número que importa es `remainingPercent`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeSessionIndex, fakeSshPath, indexRow } from '@jarvis/testkit';
import type { UsageSnapshot } from '@jarvis/contracts';
import { buildApp } from '../../apps/core/src/app.js';
import { buildServices, type CoreServices } from '../../apps/core/src/services.js';
import { openDatabase } from '../../apps/core/src/platform/db.js';
import type { FastifyInstance } from 'fastify';

const root = mkdtempSync(join(tmpdir(), 'jarvis-usage-'));
process.env['JARVIS_FAKE_SSH_ROOT'] = join(root, 'fake-ssh');

let services: CoreServices;
let app: FastifyInstance;

beforeEach(async () => {
  services = buildServices({
    db: openDatabase({ path: ':memory:' }),
    index: new FakeSessionIndex([
      indexRow(),
      indexRow({ session_key: 'local:codex:sid-cx', provider: 'codex', session_id: 'sid-cx' }),
    ]) as never,
    model: null,
    config: {
      hosts: ['bastion'], bastionHost: 'bastion', sshCommand: fakeSshPath(), knownHostsFile: '',
      spoolRoot: join(root, 'spool'), usageProbeTimeoutMs: 30_000,
    },
  });
  app = buildApp({ services, trustAllIdentities: true });
  await app.ready();
});

afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }));

const openWorkspace = async (provider: 'claude' | 'codex', sessionId: string): Promise<string> => {
  const response = await app.inject({
    method: 'POST', url: '/api/workspaces', payload: { ref: { host: 'bastion', provider, sessionId } },
  });
  return (response.json() as { workspace: { id: string } }).workspace.id;
};

describe('USAGE · lo que la cabecera del workspace promete', () => {
  it('Claude: cuenta, sesión y semana, con el restante calculado', async () => {
    const workspaceId = await openWorkspace('claude', 'sid-1');
    const response = await app.inject({ method: 'GET', url: `/api/usage?workspaceId=${workspaceId}` });
    expect(response.statusCode).toBe(200);
    const usage = response.json<UsageSnapshot>();

    expect(usage.account).toMatchObject({ email: 'operador@ejemplo.dev', plan: 'max' });
    expect(usage.executionHost).toBe('bastion');
    const session = usage.limits.find((entry) => entry.label === 'session');
    const week = usage.limits.find((entry) => entry.label === 'week');
    // El badge enseña el restante: 45% gastado son 55% disponibles.
    expect(session).toMatchObject({ usedPercent: 45, remainingPercent: 55 });
    expect(session?.resetDescription).toContain('2:30pm');
    expect(week).toMatchObject({ usedPercent: 12, remainingPercent: 88 });
    expect(usage.stale).toBe(false);
  }, 40_000);

  it('Codex: las dos ventanas, con su duración y su reinicio', async () => {
    const workspaceId = await openWorkspace('codex', 'sid-cx');
    const usage = (await app.inject({ method: 'GET', url: `/api/usage?workspaceId=${workspaceId}` }))
      .json<UsageSnapshot>();

    expect(usage.account).toMatchObject({ email: 'operador@ejemplo.dev', plan: 'pro', authMethod: 'chatgpt' });
    expect(usage.limits.map((entry) => entry.label)).toEqual(['5h', 'week']);
    expect(usage.limits[0]).toMatchObject({ usedPercent: 31, remainingPercent: 69, windowMinutes: 300 });
    // El momento del reinicio viaja como fecha, no como texto: la interfaz decide cómo contarlo.
    expect(usage.limits[0]?.resetsAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  }, 40_000);

  it('un host que no responde conserva el último dato bueno y lo marca viejo', async () => {
    const workspaceId = await openWorkspace('claude', 'sid-1');
    const fresh = (await app.inject({ method: 'GET', url: `/api/usage?workspaceId=${workspaceId}` }))
      .json<UsageSnapshot>();
    expect(fresh.limits.length).toBe(2);

    // Se envejece el snapshot y se rompe el camino al host: el sondeo siguiente falla de verdad.
    services.db.prepare("UPDATE usage_snapshots SET fetched_at = '2020-01-01T00:00:00.000Z'").run();
    services.sshConfig.hosts = ['deadhost'];
    services.sshConfig.allowlist = new Set(['deadhost']);

    const stale = (await app.inject({ method: 'GET', url: `/api/usage?workspaceId=${workspaceId}` }))
      .json<UsageSnapshot>();
    expect(stale.stale).toBe(true);
    expect(stale.refreshError).toBeTruthy();
    // Lo que se enseña sigue siendo el último dato conocido, fechado.
    expect(stale.limits).toEqual(fresh.limits);
    expect(stale.fetchedAt).toBe('2020-01-01T00:00:00.000Z');
  }, 40_000);

  it('opencode no tiene cuota que enseñar, y se dice en vez de inventarla', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/usage?provider=opencode&host=bastion' });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('BAD_REQUEST');
  });
});
