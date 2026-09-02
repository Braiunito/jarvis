/**
 * Gate M3: un run es durable.
 *
 * Esto no usa dobles: corre agentes falsos dentro de tmux de verdad, a través del ssh falso, con
 * spool en ficheros reales. Matar el core aquí significa cerrar sus servicios y levantar otros
 * nuevos contra la misma base y los mismos hosts, que es exactamente lo que hace `docker restart`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeSessionIndex, fakeSshPath, indexRow, waitFor } from '@jarvis/testkit';
import { sshExec, defaultSshConfig } from '@jarvis/agent-adapters';
import type { Run, RunEvent } from '@jarvis/contracts';
import { buildApp } from '../../apps/core/src/app.js';
import { buildServices, type CoreServices } from '../../apps/core/src/services.js';
import { openDatabase } from '../../apps/core/src/platform/db.js';
import type { FastifyInstance } from 'fastify';

const root = mkdtempSync(join(tmpdir(), 'jarvis-m3-'));
const dbPath = join(root, 'core.db');
const spoolRoot = join(root, 'spool');

process.env['JARVIS_FAKE_SSH_ROOT'] = join(root, 'fake-ssh');

const index = new FakeSessionIndex([
  indexRow(),
  indexRow({ session_key: 'goro2:claude:sid-2', host: 'serverB', session_id: 'sid-2', title: 'deploy del bastión' }),
]);

const overrides = {
  database: dbPath,
  hosts: ['bastion', 'serverB', 'serverC', 'deadhost'],
  bastionHost: 'bastion',
  sshCommand: fakeSshPath(),
  knownHostsFile: '',
  spoolRoot,
  attachmentRoot: join(root, 'attachments'),
  pollIntervalMs: 200,
  interruptGraceMs: 800,
  maxConcurrentRuns: 8,
  capabilityTtlMs: 60_000,
};

interface Harness { services: CoreServices; app: FastifyInstance }

async function boot(): Promise<Harness> {
  const services = buildServices({
    db: openDatabase({ path: dbPath }),
    index: index as never,
    config: overrides,
  });
  const app = buildApp({ services, trustAllIdentities: true });
  await app.ready();
  await services.supervisor.start();
  return { services, app };
}

async function shutdown(harness: Harness): Promise<void> {
  harness.services.supervisor.stop();
  await harness.app.close();
  harness.services.close();
}

let harness: Harness;

beforeEach(async () => {
  harness = await boot();
});

afterEach(async () => {
  await shutdown(harness);
});

afterAll(async () => {
  // Las sesiones tmux de los hosts falsos viven en sockets propios: se apagan al terminar.
  const config = defaultSshConfig({ sshCommand: fakeSshPath(), hosts: ['bastion', 'serverB'], knownHostsFile: '' });
  for (const host of ['bastion', 'serverB']) {
    await sshExec({ host, command: 'tmux kill-server 2>/dev/null || true', config }).catch(() => undefined);
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
});

async function openWorkspace(app: FastifyInstance, sessionId = 'sid-1', host = 'bastion'): Promise<string> {
  const response = await app.inject({
    method: 'POST', url: '/api/workspaces',
    payload: { ref: { host, provider: 'claude', sessionId }, cwd: null },
  });
  expect([200, 201]).toContain(response.statusCode);
  return (response.json() as { workspace: { id: string } }).workspace.id;
}

async function createRun(app: FastifyInstance, workspaceId: string, prompt: string, extra: Record<string, unknown> = {}) {
  const response = await app.inject({
    method: 'POST', url: '/api/runs', payload: { workspaceId, prompt, ...extra },
  });
  return response;
}

const runOf = async (app: FastifyInstance, runId: string): Promise<Run> =>
  (await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).json<{ run: Run }>().run;

const eventsOf = async (app: FastifyInstance, runId: string, afterSeq = -1): Promise<RunEvent[]> =>
  (await app.inject({ method: 'GET', url: `/api/runs/${runId}/events?afterSeq=${afterSeq}` })).json<{ events: RunEvent[] }>().events;

describe('M3 · un run llega hasta el final y deja evidencia', () => {
  it('crea, ejecuta y termina, con el destino exacto que se prometió', async () => {
    const workspaceId = await openWorkspace(harness.app);

    const target = (await harness.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}/target` }))
      .json<{ target: { executionHost: string; strategy: string; permissionProfile: string } }>().target;
    expect(target).toMatchObject({ executionHost: 'bastion', strategy: 'bastion', permissionProfile: 'safe' });

    const created = await createRun(harness.app, workspaceId, 'revisa el log');
    expect(created.statusCode).toBe(202);
    const { run } = created.json<{ run: Run }>();
    expect(run.status).toBe('queued');

    const finished = await waitFor(
      () => runOf(harness.app, run.id),
      (value) => value.status === 'completed',
      { what: 'que el run termine', timeoutMs: 30_000 },
    );
    expect(finished.resultOk).toBe(true);
    expect(finished.exitCode).toBe(0);
    // El snapshot del destino es lo que se ejecutó, no algo recalculado al mostrarlo.
    expect(finished.executionHost).toBe('bastion');
    expect(finished.strategy).toBe('bastion');
    expect(finished.permissionProfile).toBe('safe');

    const events = await eventsOf(harness.app, run.id);
    const types = events.map((event) => event.type);
    expect(types[0]).toBe('run.target');
    expect(types).toContain('agent.started');
    expect(types).toContain('agent.tool');
    expect(types).toContain('agent.result');
    // seq contiguo y sin repeticiones.
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));

    // La auditoría afirma el mismo destino que la fila del run.
    const audit = harness.services.audit.recent(10).find((entry) => entry['run_id'] === run.id);
    const payload = JSON.parse(String(audit?.['payload_json'])) as { strategy: string; permissionProfile: string };
    expect(payload.strategy).toBe(finished.strategy);
    expect(payload.permissionProfile).toBe(finished.permissionProfile);
    // El prompt no entra en la auditoría: sólo su tamaño.
    expect(JSON.stringify(audit)).not.toContain('revisa el log');
  });

  it('estrategia A: el agente corre en el bastión y se le dice dónde está el trabajo', async () => {
    const workspaceId = await openWorkspace(harness.app, 'sid-2', 'serverB');
    const created = await createRun(harness.app, workspaceId, 'mira el deploy');
    const { run, target } = created.json<{ run: Run; target: { strategy: string; workHost: string } }>();
    expect(target.strategy).toBe('A');
    expect(target.workHost).toBe('serverB');

    const finished = await waitFor(() => runOf(harness.app, run.id), (value) => value.status === 'completed', {
      what: 'el run de estrategia A', timeoutMs: 30_000,
    });
    expect(finished.executionHost).toBe('bastion');

    // El preámbulo viaja dentro del prompt, y el agente falso lo devuelve en su respuesta.
    const spool = readFileSync(join(spoolRoot, run.id, 'events.ndjson'), 'utf8');
    expect(spool).toContain('You are running on the bastion');
    expect(spool).toContain('ssh serverB');
  });

  it('dos envíos con la misma clave de idempotencia crean un solo run', async () => {
    const workspaceId = await openWorkspace(harness.app);
    const key = 'idem-1';
    const first = await createRun(harness.app, workspaceId, 'una vez', { idempotencyKey: key });
    const second = await createRun(harness.app, workspaceId, 'una vez', { idempotencyKey: key });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(second.json<{ replayed: boolean }>().replayed).toBe(true);
    expect(second.json<{ run: Run }>().run.id).toBe(first.json<{ run: Run }>().run.id);

    // La misma clave con otra petición es un conflicto, nunca «haz lo último».
    const conflicting = await createRun(harness.app, workspaceId, 'otra cosa', { idempotencyKey: key });
    expect(conflicting.statusCode).toBe(409);
    expect(conflicting.json<{ error: { code: string } }>().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });
});

describe('M3 · el run sobrevive al core', () => {
  it('reiniciar el core adopta el run desde el spool sin duplicar ni perder eventos', async () => {
    const workspaceId = await openWorkspace(harness.app);
    const { run } = (await createRun(harness.app, workspaceId, '@@slow:8 tarda un poco')).json<{ run: Run }>();

    // Se espera a que esté vivo de verdad y con algo ya ingerido.
    await waitFor(() => runOf(harness.app, run.id), (value) => value.status === 'running', { what: 'que arranque' });
    const before = await waitFor(
      () => eventsOf(harness.app, run.id),
      (events) => events.some((event) => event.type === 'agent.text'),
      { what: 'los primeros eventos' },
    );
    const seenSeqs = before.map((event) => event.seq);

    // Muere el core a mitad de la ejecución.
    await shutdown(harness);
    harness = await boot();

    const finished = await waitFor(() => runOf(harness.app, run.id), (value) => value.status === 'completed', {
      what: 'que termine tras el reinicio', timeoutMs: 40_000,
    });
    expect(finished.status).toBe('completed');

    const after = await eventsOf(harness.app, run.id);
    // Ni un `seq` reutilizado ni un evento perdido entre los dos procesos.
    expect(after.map((event) => event.seq)).toEqual(after.map((_, index) => index));
    expect(after.length).toBeGreaterThan(before.length);
    for (const seq of seenSeqs) {
      const beforeEvent = before.find((event) => event.seq === seq);
      const afterEvent = after.find((event) => event.seq === seq);
      expect(afterEvent?.type).toBe(beforeEvent?.type);
    }
    const texts = after.filter((event) => event.type === 'agent.text')
      .map((event) => (event.payload as { text: string }).text);
    expect(new Set(texts).size).toBe(texts.length);
    expect(texts.filter((text) => text.startsWith('paso '))).toHaveLength(8);
  });

  it('preparar dos veces el mismo run no lanza un segundo agente', async () => {
    const workspaceId = await openWorkspace(harness.app);
    const { run } = (await createRun(harness.app, workspaceId, '@@slow:4 idempotente')).json<{ run: Run }>();
    await waitFor(() => runOf(harness.app, run.id), (value) => value.status === 'running', { what: 'que arranque' });

    // Volver a preparar es lo que pasaría si el core muriese entre el ssh y el commit.
    await harness.services.runs.prepare(run.id);
    const finished = await waitFor(() => runOf(harness.app, run.id), (value) => value.status === 'completed', {
      what: 'que termine', timeoutMs: 30_000,
    });
    expect(finished.status).toBe('completed');
    const results = (await eventsOf(harness.app, run.id)).filter((event) => event.type === 'agent.result');
    expect(results).toHaveLength(1);
  });
});

describe('M3 · cancelación', () => {
  it('un agente que ignora SIGINT acaba parado y el run queda en cancelled', async () => {
    const workspaceId = await openWorkspace(harness.app);
    const { run } = (await createRun(harness.app, workspaceId, '@@hang no me pares')).json<{ run: Run }>();
    await waitFor(() => runOf(harness.app, run.id), (value) => value.status === 'running', { what: 'que arranque' });

    const cancelled = await harness.app.inject({ method: 'POST', url: `/api/runs/${run.id}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    // No se declara parado antes de comprobarlo.
    expect(cancelled.json<{ run: Run }>().run.status).toBe('cancelling');

    const finished = await waitFor(() => runOf(harness.app, run.id), (value) => value.status === 'cancelled', {
      what: 'que se confirme la cancelación', timeoutMs: 30_000,
    });
    expect(finished.status).toBe('cancelled');
    expect(finished.finishedAt).toBeTruthy();
  });

  it('cancelar dos veces es idempotente y no deja proceso suelto', async () => {
    const workspaceId = await openWorkspace(harness.app);
    const { run } = (await createRun(harness.app, workspaceId, '@@hang doble')).json<{ run: Run }>();
    await waitFor(() => runOf(harness.app, run.id), (value) => value.status === 'running', { what: 'que arranque' });

    await harness.app.inject({ method: 'POST', url: `/api/runs/${run.id}/cancel` });
    await harness.app.inject({ method: 'POST', url: `/api/runs/${run.id}/cancel` });
    await waitFor(() => runOf(harness.app, run.id), (value) => value.status === 'cancelled', {
      what: 'la cancelación', timeoutMs: 30_000,
    });

    const config = defaultSshConfig({ sshCommand: fakeSshPath(), hosts: ['bastion'], knownHostsFile: '' });
    const sessions = await sshExec({ host: 'bastion', command: 'tmux list-sessions -F "#{session_name}" 2>/dev/null || true', config });
    expect(sessions.stdout).not.toContain(`jarvis-run-${run.id}`);

    // Cancelar un run ya terminado no cambia nada ni falla.
    const again = await harness.app.inject({ method: 'POST', url: `/api/runs/${run.id}/cancel` });
    expect(again.statusCode).toBe(200);
    expect(again.json<{ run: Run }>().run.status).toBe('cancelled');
  });
});

describe('TEC-11 · una sesión cuyo directorio nadie sabía', () => {
  /**
   * Directorio real, no simulado: la sonda pregunta a la máquina con `test -d`, así que probarla
   * contra un árbol inventado no probaría nada. El nombre es alfanumérico porque el patrón viaja
   * al shell sin comillas, que es lo que le permite ser un glob.
   */
  const proyecto = join(tmpdir(), `jarvisdemo${process.pid}`, 'miproyecto');

  it('deduce el directorio del nombre del proyecto, lo usa y lo deja escrito', async () => {
    mkdirSync(proyecto, { recursive: true });
    const slug = proyecto.replace(/[^A-Za-z0-9]/g, '-');
    index.rows.push(indexRow({
      session_key: 'bastion:claude:sid-sincwd',
      host: 'bastion',
      session_id: 'sid-sincwd',
      // Una sesión sin ningún turno no declara su `cwd` en ninguna línea del transcript, y son
      // justo las que el índice trae vacías: diez había en la flota.
      cwd: '',
      path: `/home/dev/.claude/projects/${slug}/sid-sincwd.jsonl`,
    }));

    const workspaceId = await openWorkspace(harness.app, 'sid-sincwd');
    const { run } = (await createRun(harness.app, workspaceId, 'sigue donde lo dejaste')).json<{ run: Run }>();

    // El trabajo sale hacia el directorio deducido, no hacia el directorio por defecto.
    expect(run.cwd).toBe(proyecto);
    const finished = await waitFor(() => runOf(harness.app, run.id), (value) => value.status === 'completed', {
      what: 'el run con el directorio deducido', timeoutMs: 30_000,
    });
    expect(finished.status).toBe('completed');

    // Y queda escrito, marcado como deducción: el siguiente trabajo ya no paga la consulta, y la
    // interfaz puede decir que eso lo dedujo el sistema en vez de presentarlo como un hecho.
    const workspace = (await harness.app.inject({ method: 'GET', url: `/api/workspaces/${workspaceId}` }))
      .json<{ workspace: { cwd: string | null; cwdSource: string | null } }>().workspace;
    expect(workspace.cwd).toBe(proyecto);
    expect(workspace.cwdSource).toBe('derived');

    rmSync(join(tmpdir(), `jarvisdemo${process.pid}`), { recursive: true, force: true });
  });

  it('un directorio que no existe no se inventa: el trabajo sale sin él', async () => {
    index.rows.push(indexRow({
      session_key: 'bastion:claude:sid-fantasma',
      host: 'bastion',
      session_id: 'sid-fantasma',
      cwd: '',
      path: '/home/dev/.claude/projects/-esto-no-existe-en-ninguna-parte/sid-fantasma.jsonl',
    }));
    const workspaceId = await openWorkspace(harness.app, 'sid-fantasma');
    const { run } = (await createRun(harness.app, workspaceId, 'a ver qué pasa')).json<{ run: Run }>();
    expect(run.cwd).toBeNull();
  });
});

describe('M3 · fallos y límites', () => {
  it('un agente que falla termina en failed con su código de salida', async () => {
    const workspaceId = await openWorkspace(harness.app);
    const { run } = (await createRun(harness.app, workspaceId, '@@fail rompe')).json<{ run: Run }>();
    const finished = await waitFor(() => runOf(harness.app, run.id), (value) => value.status === 'failed', {
      what: 'el fallo', timeoutMs: 30_000,
    });
    expect(finished.exitCode).toBe(1);
    expect(finished.errorCode).toBeTruthy();
  });

  it('una salida enorme se recorta con marca y no crece sin límite', async () => {
    const workspaceId = await openWorkspace(harness.app);
    const { run } = (await createRun(harness.app, workspaceId, '@@big:600 dame mucho')).json<{ run: Run }>();
    await waitFor(() => runOf(harness.app, run.id), (value) => value.status === 'completed', {
      what: 'el run grande', timeoutMs: 40_000,
    });
    const tool = (await eventsOf(harness.app, run.id))
      .filter((event) => event.type === 'agent.tool')
      .map((event) => event.payload as { tool: { output?: string; truncated?: boolean; originalBytes?: number } })
      .find((payload) => payload.tool.truncated);
    expect(tool?.tool.originalBytes).toBeGreaterThan(500_000);
    expect(Buffer.byteLength(tool?.tool.output ?? '', 'utf8')).toBeLessThanOrEqual(33 * 1024);
  });

  it('un host que no responde no crea el run: falla con un código que la UI entiende', async () => {
    const workspaceId = await openWorkspace(harness.app, 'sid-dead', 'deadhost');
    // deadhost no responde y el bastión sí tiene claude: la estrategia A es correcta aquí.
    const created = await createRun(harness.app, workspaceId, 'algo');
    expect(created.statusCode).toBe(202);
    expect(created.json<{ target: { strategy: string; reason: string } }>().target.strategy).toBe('A');
  });
});
