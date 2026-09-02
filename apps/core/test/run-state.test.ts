/**
 * Contrato RUN-STATE-01 y RUN-EVENT-01: la máquina de estados y el event log.
 *
 * Sin SSH ni hosts: aquí sólo se comprueba que nadie puede llevar un run a un estado imposible y
 * que `seq` es lo que la API promete que es.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { canTransition, isTerminalStatus, JarvisError, RUN_STATUSES, RUN_TRANSITIONS, type RunStatus } from '@jarvis/contracts';
import { FakeSessionIndex } from '@jarvis/testkit';
import { openDatabase } from '../src/platform/db.js';
import { fixedClock } from '../src/platform/clock.js';
import { buildServices, type CoreServices } from '../src/services.js';
import { spoolLayout } from '@jarvis/agent-adapters';
import { stripAnsi } from '../src/runs/supervisor.js';

const user = { userId: 'u1', username: 'braian' };

function makeServices(): CoreServices {
  const db = openDatabase({ path: ':memory:' });
  return buildServices({
    db,
    clock: fixedClock('2026-09-02T10:00:00.000Z'),
    index: new FakeSessionIndex() as never,
    config: { hosts: ['bastion'], bastionHost: 'bastion', spoolRoot: '/tmp/jarvis-unit-spool' },
  });
}

let services: CoreServices;
beforeEach(() => {
  services = makeServices();
});

function seedRun(status: RunStatus = 'queued'): string {
  const { workspace } = services.workspaces.open({
    ref: { host: 'bastion', provider: 'claude', sessionId: 'sid-1' },
  }, user);
  const runId = 'r0000000000000001';
  services.runRepository.insert({
    id: runId,
    workspaceId: workspace.id,
    createdBy: user.username,
    provider: 'claude',
    sessionId: 'sid-1',
    prompt: 'hola',
    workHost: 'bastion',
    executionHost: 'bastion',
    strategy: 'bastion',
    strategyReason: null,
    cwd: null,
    permissionProfile: 'safe',
    model: null,
    attempt: 1,
    parentRunId: null,
    remoteName: `jarvis-run-${runId}`,
    remoteSpoolDir: `/tmp/jarvis-unit-spool/${runId}`,
    createdAt: '2026-09-02T10:00:00.000Z',
    deadlineAt: null,
  });
  if (status !== 'queued') {
    const path: Record<RunStatus, RunStatus[]> = {
      queued: [],
      preparing: ['preparing'],
      running: ['preparing', 'running'],
      waiting: ['preparing', 'running', 'waiting'],
      cancelling: ['preparing', 'running', 'cancelling'],
      completed: ['preparing', 'running', 'completed'],
      failed: ['preparing', 'running', 'failed'],
      cancelled: ['preparing', 'running', 'cancelling', 'cancelled'],
      timed_out: ['preparing', 'running', 'timed_out'],
    };
    for (const step of path[status]) services.runs.transition(runId, step);
  }
  return runId;
}

describe('RUN-STATE-01', () => {
  it('la tabla de transiciones cubre todos los estados y los terminales no salen de sí mismos', () => {
    for (const status of RUN_STATUSES) {
      expect(RUN_TRANSITIONS[status]).toBeDefined();
      if (isTerminalStatus(status)) expect(RUN_TRANSITIONS[status]).toEqual([]);
    }
    expect(canTransition('queued', 'running')).toBe(false);
    expect(canTransition('running', 'completed')).toBe(true);
    expect(canTransition('completed', 'running')).toBe(false);
  });

  it('una transición inválida es un error, no un «best effort»', () => {
    const runId = seedRun('queued');
    expect(() => services.runs.transition(runId, 'completed')).toThrow(JarvisError);
    expect(services.runs.require(runId).status).toBe('queued');
  });

  it('un estado terminal es inmutable', () => {
    const runId = seedRun('completed');
    expect(() => services.runs.transition(runId, 'running')).toThrow(/already completed/);
    // Volver al mismo terminal es idempotente y no duplica eventos.
    const before = services.runs.events(runId, -1).length;
    services.runs.transition(runId, 'completed');
    expect(services.runs.events(runId, -1).length).toBe(before);
  });

  it('cada transición deja su evento run.status con el origen y el destino', () => {
    const runId = seedRun('running');
    const statuses = services.runs.events(runId, -1)
      .filter((event) => event.type === 'run.status')
      .map((event) => event.payload as { from: string; to: string });
    expect(statuses).toEqual([
      { from: 'queued', to: 'preparing', reason: null },
      { from: 'preparing', to: 'running', reason: null },
    ]);
  });
});

describe('RUN-EVENT-01', () => {
  it('seq empieza en 0, es monotónico y no se repite', () => {
    const runId = seedRun('running');
    const events = services.runs.events(runId, -1);
    expect(events[0]?.seq).toBe(0);
    const seqs = events.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('la ingesta sólo consume líneas completas y no inventa eventos', () => {
    const runId = seedRun('running');
    const partial = '{"type":"assistant","message":{"content":[{"type":"text","text":"hola"}]}}\n{"type":"resu';
    const first = services.runs.ingest(runId, partial, 0);
    expect(first.events).toBe(1);
    // El resto de la línea se reintenta desde el cursor, no se descarta.
    expect(first.consumedBytes).toBe(Buffer.byteLength(partial.split('\n')[0] + '\n', 'utf8'));

    const rest = '{"type":"result","is_error":false,"result":"listo"}\n';
    const second = services.runs.ingest(runId, rest, first.consumedBytes);
    expect(second.events).toBe(1);
    expect(services.runs.require(runId).resultOk).toBe(true);
  });

  it('una línea que no es JSON se conserva como raw en vez de romper el run', () => {
    const runId = seedRun('running');
    services.runs.ingest(runId, 'bienvenido a la CLI\n', 0);
    const last = services.runs.events(runId, -1).at(-1);
    expect(last?.type).toBe('agent.raw');
  });

  it('un payload grande se recorta con marca y tamaño original, nunca en silencio', () => {
    const runId = seedRun('running');
    const huge = 'x'.repeat(200_000);
    const line = `${JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: huge }] },
    })}\n`;
    services.runs.ingest(runId, line, 0);
    const event = services.runs.events(runId, -1).at(-1);
    const payload = event?.payload as { tool: { output: string; truncated?: boolean; originalBytes?: number } };
    expect(payload.tool.truncated).toBe(true);
    expect(payload.tool.originalBytes).toBe(200_000);
    expect(payload.tool.output.length).toBeLessThan(200_000);
    expect(payload.tool.output.startsWith('[earlier output omitted]')).toBe(true);
  });

  it('dos eventos de tool no comparten el mismo objeto', () => {
    const runId = seedRun('running');
    const chunk = [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { a: 1 } }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { a: 2 } }] } }),
      '',
    ].join('\n');
    services.runs.ingest(runId, chunk, 0);
    const tools = services.runs.events(runId, -1)
      .filter((event) => event.type === 'agent.tool')
      .map((event) => (event.payload as { tool: { id: string } }).tool);
    expect(tools).toHaveLength(2);
    expect(tools[0]?.id).toBe('t1');
    expect(tools[1]?.id).toBe('t2');
  });

  it('un error del modelo no se guarda como resultado vacío exitoso', () => {
    const runId = seedRun('running');
    services.runs.ingest(runId, `${JSON.stringify({ type: 'turn.failed', error: { message: 'nope' } })}\n`, 0);
    const run = services.runs.require(runId);
    expect(run.resultOk).toBeNull();
  });
});

describe('drafts con compare-and-swap', () => {
  it('una versión desfasada da 409 y no pisa el contenido', () => {
    const { workspace } = services.workspaces.open({
      ref: { host: 'bastion', provider: 'claude', sessionId: 'sid-draft' },
    }, user);
    const first = services.workspaces.putDraft(workspace.id, user, 'primera', 0);
    expect(first.version).toBe(1);
    expect(() => services.workspaces.putDraft(workspace.id, user, 'pisa', 0)).toThrow(/version/i);
    expect(services.workspaces.draft(workspace.id, user).body).toBe('primera');
    expect(services.workspaces.putDraft(workspace.id, user, 'segunda', 1).version).toBe(2);
  });
});

describe('workspaces', () => {
  it('abrir dos veces la misma sesión devuelve el mismo workspace', () => {
    const ref = { host: 'bastion', provider: 'claude' as const, sessionId: 'sid-x' };
    const first = services.workspaces.open({ ref }, user);
    const second = services.workspaces.open({ ref }, user);
    expect(second.created).toBe(false);
    expect(second.workspace.id).toBe(first.workspace.id);
  });

  it('«local» se normaliza al bastión y no se persiste', () => {
    const { workspace } = services.workspaces.open({
      ref: { host: 'local', provider: 'claude', sessionId: 'sid-local' },
    }, user);
    expect(workspace.ref.host).toBe('bastion');
    const rows = services.db.prepare('SELECT session_host FROM workspaces').all() as Array<{ session_host: string }>;
    expect(rows.every((row) => row.session_host !== 'local')).toBe(true);
  });
});

/**
 * Lo que se aprendió corriendo contra las CLIs de verdad, no contra las falsas.
 *
 * Los dos casos vienen de la primera campaña contra zeus, goro2 y vultr: un valor por defecto que
 * no podía funcionar y un error que llegaba ilegible.
 */
describe('lo que enseñó la prueba contra máquinas reales', () => {
  it('el spool tiene que ser una ruta absoluta de verdad, resuelta por host', () => {
    // `$HOME/...` entrecomillado no lo expande nadie: hay que resolverlo con el home de la
    // máquina que ejecuta, y ese home no es el mismo en zeus que en vultr.
    expect(spoolLayout('/home/zeus/.local/state/jarvis/runs', 'r1').dir)
      .toBe('/home/zeus/.local/state/jarvis/runs/r1');
    expect(spoolLayout('/root/.local/state/jarvis/runs', 'r1').dir)
      .toBe('/root/.local/state/jarvis/runs/r1');
    expect(() => spoolLayout('$HOME/.local/state/jarvis/runs', 'r1')).toThrow(/absolute/);
  });

  it('la línea de error que se enseña va sin color de terminal', () => {
    // opencode escribe sus errores con ANSI aunque nadie mire; así llegaban a la tarjeta.
    expect(stripAnsi('[91m[1mError: [0mSession not found'))
      .toBe('Error: Session not found');
    expect(stripAnsi('sin color')).toBe('sin color');
  });
});
