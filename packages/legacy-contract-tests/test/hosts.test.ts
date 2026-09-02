/**
 * Contratos HOST-*: qué máquina ejecuta el agente y qué se le cuenta al respecto.
 *
 * Corre contra el ssh falso del testkit, que monta hosts reales en esta máquina: `bastion` con
 * los tres CLIs, `serverB` sin ninguno (fuerza estrategia A), `serverC` con claude pero sin tmux
 * y `deadhost` que rechaza la conexión.
 */
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CapabilityCache, defaultSshConfig, HostUnreachableError, resolveTarget, strategyPreamble,
  TargetImpossibleError,
} from '@jarvis/agent-adapters';

const fakeSsh = resolve(import.meta.dirname, '../../testkit/bin/fake-ssh.mjs');
process.env['JARVIS_FAKE_SSH_ROOT'] = '/tmp/jarvis-contract-hosts';

const config = defaultSshConfig({
  sshCommand: fakeSsh,
  hosts: ['bastion', 'serverB', 'serverC', 'deadhost'],
  bastionHost: 'bastion',
  knownHostsFile: '',
});

let capabilities: CapabilityCache;
beforeEach(() => {
  capabilities = new CapabilityCache({ config, ttlMs: 60_000 });
});

const target = (options: Partial<Parameters<typeof resolveTarget>[0]> = {}) => resolveTarget({
  sessionHost: 'bastion',
  provider: 'claude',
  permissionProfile: 'safe',
  capabilities,
  bastionHost: 'bastion',
  ...options,
});

describe('HOST-CAP-01', () => {
  it('descubre binarios por host y cachea el resultado', async () => {
    const first = await capabilities.detect('bastion');
    expect(first.providers).toEqual(['claude', 'codex', 'opencode']);
    expect(first.tmux).toBe(true);
    expect(first.binaries['claude']).toContain('/claude');

    // La segunda llamada sale de la caché: el objeto es idéntico.
    expect(await capabilities.detect('bastion')).toBe(first);
  });

  it('un host sin CLIs de agente se reporta como tal, no como error', async () => {
    const serverB = await capabilities.detect('serverB');
    expect(serverB.providers).toEqual([]);
    expect(serverB.tmux).toBe(true);
  });

  it('un host inalcanzable lanza con la causa real de ssh', async () => {
    await expect(capabilities.detect('deadhost')).rejects.toThrow(HostUnreachableError);
    await expect(capabilities.detect('deadhost')).rejects.toThrow(/No route to host/);
  });
});

describe('HOST-TARGET-01', () => {
  it('la sesión del bastión se ejecuta en el bastión', async () => {
    expect(await target({ sessionHost: 'bastion' })).toMatchObject({
      workHost: 'bastion', executionHost: 'bastion', strategy: 'bastion',
    });
  });

  it('«local» es el bastión y nunca se propaga', async () => {
    const plan = await target({ sessionHost: 'local' });
    expect(plan.workHost).toBe('bastion');
    expect(plan.executionHost).toBe('bastion');
    expect(JSON.stringify(plan)).not.toContain('local');
  });

  it('estrategia B cuando el CLI está en el host de la sesión', async () => {
    expect(await target({ sessionHost: 'serverC', provider: 'claude' })).toMatchObject({
      workHost: 'serverC', executionHost: 'serverC', strategy: 'B',
    });
  });

  it('estrategia A cuando el host de la sesión no tiene el CLI, con motivo explícito', async () => {
    const plan = await target({ sessionHost: 'serverB', provider: 'claude', cwd: '/srv/app' });
    expect(plan).toMatchObject({ workHost: 'serverB', executionHost: 'bastion', strategy: 'A' });
    expect(plan.reason).toMatch(/not installed on serverB/);
    // El cwd es del host de trabajo y no existe en el bastión: no se propaga.
    expect(plan.cwd).toBeNull();
  });

  it('un host que no responde se conduce desde el bastión en vez de fallar', async () => {
    const plan = await target({ sessionHost: 'deadhost', provider: 'claude' });
    expect(plan.strategy).toBe('A');
    expect(plan.reason).toMatch(/could not be probed/);
  });

  it('pedir B donde es imposible falla en vez de degradar en silencio', async () => {
    await expect(target({ sessionHost: 'serverB', provider: 'claude', preferred: 'B' }))
      .rejects.toThrow(TargetImpossibleError);
  });

  it('pedir A no consulta capacidades del target y ejecuta en el bastión', async () => {
    expect(await target({ sessionHost: 'serverB', preferred: 'A' })).toMatchObject({
      executionHost: 'bastion', workHost: 'serverB', strategy: 'A',
    });
  });

  it('un proveedor que no está en ninguna parte falla con PROVIDER_MISSING', async () => {
    // Bastión sin codex y sesión en él: no queda ninguna máquina donde ejecutarlo.
    await expect(resolveTarget({
      sessionHost: 'serverC', provider: 'codex', permissionProfile: 'safe',
      capabilities, bastionHost: 'serverC',
    })).rejects.toMatchObject({ code: 'PROVIDER_MISSING' });

    // Y con la sesión en otro host tampoco se inventa un destino.
    await expect(resolveTarget({
      sessionHost: 'serverB', provider: 'codex', permissionProfile: 'safe',
      capabilities, bastionHost: 'serverC',
    })).rejects.toMatchObject({ code: 'PROVIDER_MISSING' });
  });

  it('el perfil de permiso viaja en el plan y no se eleva solo', async () => {
    expect((await target({ permissionProfile: 'safe' })).permissionProfile).toBe('safe');
    expect((await target({ permissionProfile: 'auto' })).permissionProfile).toBe('auto');
  });
});

describe('HOST-PREAMBLE-01', () => {
  it('la estrategia A avisa al agente de dónde está de verdad', () => {
    const preamble = strategyPreamble({
      strategy: 'A', workHost: 'goro2', cwd: '/srv/app', provider: 'claude', sessionId: 'sid-1',
    });
    expect(preamble).toContain('You are running on the bastion');
    expect(preamble).toContain('goro2');
    expect(preamble).toContain('/srv/app');
    expect(preamble).toContain('ssh goro2');
    expect(preamble).toContain('cannot be resumed from here');
  });

  it('no hay preámbulo cuando el agente sí está donde está el trabajo', () => {
    expect(strategyPreamble({ strategy: 'B', workHost: 'goro2' })).toBeNull();
    expect(strategyPreamble({ strategy: 'bastion', workHost: 'bastion' })).toBeNull();
  });
});
