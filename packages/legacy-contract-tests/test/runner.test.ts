/**
 * Contrato RUNNER-SPOOL-01: el proceso del agente vive en el host, no en la conexión SSH.
 *
 * Se ejecuta de verdad contra tmux y ficheros reales a través del ssh falso, porque un contrato
 * de recuperación que sólo se prueba con dobles no prueba nada: lo que falla en producción es el
 * quoting, los permisos y el orden de escritura.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildCancelCommand, buildPollCommand, buildPrepareCommand, buildSweepCommand, claudeAdapter,
  defaultSshConfig, parsePollOutput, parsePrepareOutput, remoteScript, RunnerError, spoolLayout,
  sshExec, tmuxRunName,
} from '@jarvis/agent-adapters';
import type { TargetPlan } from '@jarvis/contracts';

const fakeSsh = resolve(import.meta.dirname, '../../testkit/bin/fake-ssh.mjs');
// Un directorio por ejecución: un spool heredado de la vez anterior haría que el arranque
// idempotente respondiera «ya terminó» y el test dejaría de probar nada.
const ROOT = mkdtempSync(join(tmpdir(), 'jarvis-contract-runner-'));
process.env['JARVIS_FAKE_SSH_ROOT'] = ROOT;
const SPOOL_ROOT = join(ROOT, 'spool');

const config = defaultSshConfig({
  sshCommand: fakeSsh, hosts: ['bastion'], bastionHost: 'bastion', knownHostsFile: '',
});

const target: TargetPlan = {
  workHost: 'bastion', executionHost: 'bastion', strategy: 'bastion', reason: null,
  cwd: null, provider: 'claude', permissionProfile: 'safe',
};

const exec = (command: string) => sshExec({ host: 'bastion', command, config }, { timeoutMs: 30_000 });

async function prepare(runId: string, prompt: string) {
  const layout = spoolLayout(SPOOL_ROOT, runId);
  const { argv, env } = claudeAdapter.buildRun({ prompt, permissionProfile: 'safe' });
  const agentCommand = remoteScript({ argv, cwd: null, env, stdinFromNull: true });
  const command = buildPrepareCommand({
    layout,
    agentCommand,
    cwd: null,
    meta: {
      version: 1, runId, provider: 'claude', target,
      createdAt: new Date().toISOString(), createdBy: 'test', wrapper: 'v1',
    },
  });
  const result = await exec(command);
  return { layout, result, outcome: parsePrepareOutput(result.stdout) };
}

async function pollUntil(layout: ReturnType<typeof spoolLayout>, predicate: (p: ReturnType<typeof parsePollOutput>) => boolean, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let offset = 0;
  let lines: string[] = [];
  for (;;) {
    const raw = await exec(buildPollCommand({ layout, offset }));
    const parsed = parsePollOutput(raw.stdout);
    if (parsed.chunk) {
      offset += Buffer.byteLength(parsed.chunk, 'utf8');
      lines = lines.concat(parsed.chunk.split('\n').filter(Boolean));
    }
    if (predicate(parsed)) return { parsed, lines, offset };
    if (Date.now() > deadline) throw new Error(`timeout esperando el spool (${lines.length} líneas)`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

afterAll(async () => {
  await exec('tmux kill-server 2>/dev/null || true');
  rmSync(ROOT, { recursive: true, force: true });
});

describe('RUNNER-SPOOL-01: layout y arranque', () => {
  it('rechaza una raíz relativa y un id de run que no es opaco', () => {
    expect(() => spoolLayout('relativo/runs', 'r1')).toThrow(RunnerError);
    expect(() => spoolLayout('/tmp/x', '../../etc')).toThrow(RunnerError);
    expect(() => spoolLayout('/tmp/x', 'a b')).toThrow(RunnerError);
    expect(() => tmuxRunName('nombre;rm -rf /')).toThrow(RunnerError);
  });

  it('el nombre de la tmux es determinista y lleva el prefijo de Jarvis', () => {
    expect(spoolLayout('/tmp/x', 'abc123').tmuxName).toBe('jarvis-run-abc123');
  });

  it('arranca, deja el spool con permisos privados y termina publicando estado', async () => {
    const { layout, outcome } = await prepare('run-basic', 'hola mundo');
    expect(outcome).toBe('started');

    const { parsed, lines } = await pollUntil(layout, (p) => p.status?.state === 'completed');
    expect(parsed.status).toMatchObject({ version: 1, state: 'completed', exitCode: 0 });
    expect(parsed.status?.finishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const events = lines.map((line) => JSON.parse(line) as { type: string });
    expect(events[0]).toMatchObject({ type: 'system', subtype: 'init' });
    expect(events.at(-1)).toMatchObject({ type: 'result' });

    // El directorio del run es 0700 y los ficheros 0600: nadie más en la máquina los lee.
    expect(statSync(layout.dir).mode & 0o777).toBe(0o700);
    expect(statSync(layout.events).mode & 0o777).toBe(0o600);
    expect(statSync(layout.meta).mode & 0o777).toBe(0o600);
  });

  it('preparar dos veces no lanza una segunda ejecución', async () => {
    const first = await prepare('run-idem', 'primera');
    expect(first.outcome).toBe('started');
    await pollUntil(first.layout, (p) => p.status?.state === 'completed');

    const second = await prepare('run-idem', 'primera');
    expect(second.outcome).toBe('already-finished');

    const { lines } = await pollUntil(first.layout, (p) => p.status?.state === 'completed');
    // Un solo `result`: no se duplicó el efecto.
    expect(lines.filter((line) => line.includes('"type":"result"')).length).toBe(1);
  });

  it('un prompt hostil llega literal al agente y no ejecuta nada', async () => {
    const nasty = '$(touch /tmp/jarvis-runner-pwned) `id` \'quote\' "dquote" ; rm -rf / && echo x';
    const { layout } = await prepare('run-nasty', nasty);
    const { lines } = await pollUntil(layout, (p) => p.status?.state === 'completed');
    const result = lines.map((l) => JSON.parse(l) as { type: string; result?: string })
      .find((event) => event.type === 'result');
    expect(result?.result).toContain('$(touch /tmp/jarvis-runner-pwned)');
    expect(() => statSync('/tmp/jarvis-runner-pwned')).toThrow();
  });

  it('el cursor de bytes no repite ni pierde líneas al leer por trozos', async () => {
    const { layout } = await prepare('run-cursor', '@@slow:6 lento');
    let offset = 0;
    const collected: string[] = [];
    const deadline = Date.now() + 25_000;
    for (;;) {
      const raw = await exec(buildPollCommand({ layout, offset, maxBytes: 200 }));
      const parsed = parsePollOutput(raw.stdout);
      // Sólo se confirman líneas completas; el resto se relee en el próximo poll.
      const lastNewline = parsed.chunk.lastIndexOf('\n');
      if (lastNewline !== -1) {
        const usable = parsed.chunk.slice(0, lastNewline + 1);
        offset += Buffer.byteLength(usable, 'utf8');
        collected.push(...usable.split('\n').filter(Boolean));
      }
      if (parsed.status && parsed.status.state !== 'running' && offset >= parsed.size) break;
      if (Date.now() > deadline) throw new Error('timeout leyendo por trozos');
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(collected.length).toBeGreaterThanOrEqual(9);
    expect(new Set(collected).size).toBe(collected.length);
    for (const line of collected) expect(() => JSON.parse(line)).not.toThrow();
    expect(collected.filter((l) => l.includes('"paso'))).toHaveLength(6);
  });
});

describe('RUNNER-SPOOL-01: cancelación', () => {
  /**
   * Lo que este contrato tiene que probar es que **el proceso muere**, no que el estado lo diga.
   *
   * Durante meses la señal amable fue SIGINT, y un shell POSIX pone SIGINT en SIG_IGN a todo lo
   * que lanza en segundo plano: el agente nacía sordo a ella y ningún `trap` puede devolvérsela.
   * Los tests pasaban igual porque miraban el `status.json`, que lo publica el wrapper. Aquí se
   * comprueba con `kill -0` que ya no hay nadie con ese PID, que es la única pregunta que importa
   * cuando alguien pulsa «parar» sobre un agente que puede escribir ficheros.
   */
  it('parar mata al agente de verdad, no sólo al shell que lo lanzó', async () => {
    const { layout, outcome } = await prepare('run-cancel', '@@hang no me pares');
    expect(outcome).toBe('started');
    await pollUntil(layout, (p) => p.alive && p.status?.state === 'running');

    const pid = (await exec(`cat ${layout.pid}`)).stdout.trim();
    expect(pid).toMatch(/^[0-9]+$/);
    // Está vivo antes de pedir nada: si no, el resto del test no probaría nada.
    expect((await exec(`kill -0 ${pid} 2>/dev/null && echo vivo || echo muerto`)).stdout.trim()).toBe('vivo');

    const soft = await exec(buildCancelCommand(layout));
    expect(soft.stdout).toContain('jarvis:cancel-sent');

    await pollUntil(layout, (p) => !p.alive || p.status?.state !== 'running');
    const despues = (await exec(`kill -0 ${pid} 2>/dev/null && echo vivo || echo muerto`)).stdout.trim();
    expect(despues).toBe('muerto');
  });

  it('un agente sordo también a SIGTERM se para al escalar, y el estado dice cancelled', async () => {
    const { layout, outcome } = await prepare('run-cancel-deaf', '@@deaf no me pares');
    expect(outcome).toBe('started');
    await pollUntil(layout, (p) => p.alive && p.status?.state === 'running');

    const soft = await exec(buildCancelCommand(layout));
    expect(soft.stdout).toContain('jarvis:cancel-sent');

    // Éste ignora las dos señales amables: sigue vivo, y por eso existe la escalada.
    await new Promise((r) => setTimeout(r, 500));
    const midway = parsePollOutput((await exec(buildPollCommand({ layout, offset: 0 }))).stdout);
    expect(midway.status?.state).toBe('running');

    await exec(buildCancelCommand(layout, { escalate: true }));
    const { parsed } = await pollUntil(layout, (p) => !p.alive || p.status?.state !== 'running');
    // O el wrapper alcanzó a publicar `cancelled`, o la tmux ya no está: en ambos casos el core
    // puede concluir la cancelación sin inventarse un éxito.
    expect(parsed.status?.state === 'cancelled' || parsed.alive === false).toBe(true);
  });

  it('cancelar dos veces es idempotente', async () => {
    const { layout } = await prepare('run-cancel-twice', '@@hang otra vez');
    await pollUntil(layout, (p) => p.alive);
    await exec(buildCancelCommand(layout));
    await exec(buildCancelCommand(layout));
    await exec(buildCancelCommand(layout, { escalate: true }));
    await exec(buildCancelCommand(layout, { escalate: true }));
    const parsed = parsePollOutput((await exec(buildPollCommand({ layout, offset: 0 }))).stdout);
    expect(parsed.alive).toBe(false);
  });
});

describe('RUNNER-SPOOL-01: parseo defensivo', () => {
  it('una respuesta que no es del protocolo se rechaza en vez de interpretarse', () => {
    expect(() => parsePollOutput('cualquier cosa')).toThrow(RunnerError);
    expect(() => parsePrepareOutput('bash: tmux: not found')).toThrow(RunnerError);
  });

  it('un status.json corrupto no rompe la ingesta', () => {
    const payload = 'JARVIS-SPOOL-V1\nsize 10\nalive 1\nstatus bm90LWpzb24=\ndata\n{"a":1}\n';
    const parsed = parsePollOutput(payload);
    expect(parsed.status).toBeNull();
    expect(parsed.size).toBe(10);
    expect(parsed.chunk).toBe('{"a":1}\n');
  });
});

/**
 * El barrido de spools, que nadie había ejecutado nunca.
 *
 * La versión anterior anidaba comillas simples dentro de comillas simples y **ningún** shell
 * remoto la aceptaba: bash contestaba `syntax error` y zsh `parse error near then`. Como el
 * resultado no lo miraba nadie, el síntoma visible era otro —el check de salud en «sin datos»—.
 * Por eso este test no compara texto: ejecuta el comando en un shell de verdad.
 */
describe('RUNNER-SWEEP-01: la limpieza se puede ejecutar', () => {
  it('borra lo terminado y viejo, y deja lo vivo y lo reciente', () => {
    const root = mkdtempSync(join(tmpdir(), 'jarvis-sweep-'));
    const viejo = join(root, 'rviejo');
    const vivo = join(root, 'rvivo');
    const reciente = join(root, 'rreciente');
    for (const dir of [viejo, vivo, reciente]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(viejo, 'status.json'), '{"state":"completed","exitCode":0}');
    writeFileSync(join(vivo, 'status.json'), '{"state":"running"}');
    writeFileSync(join(reciente, 'status.json'), '{"state":"failed","exitCode":1}');
    // Envejecer los dos primeros más allá del corte; el tercero se queda de hoy.
    const old = new Date(Date.now() - 30 * 86_400_000);
    utimesSync(viejo, old, old);
    utimesSync(vivo, old, old);

    const output = execFileSync('/bin/sh', ['-c', buildSweepCommand(root, 7)], { encoding: 'utf8' });

    expect(output).toContain('jarvis:swept');
    expect(existsSync(viejo)).toBe(false);
    // Un trabajo en marcha no se toca aunque su directorio sea viejo.
    expect(existsSync(vivo)).toBe(true);
    // Y lo terminado hace un rato tampoco: el corte es el corte.
    expect(existsSync(reciente)).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it('un spool que no es una ruta absoluta se rechaza antes de tocar nada', () => {
    expect(() => buildSweepCommand('~/.local/state/jarvis/runs', 7)).toThrow(/absolute/);
  });
});
