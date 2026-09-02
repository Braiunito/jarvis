/**
 * Gate M4 (Assistant): el modelo propone, el core posee el estado.
 *
 * Lo que se prueba es lo que hace durable a un plan: ninguna llamada abierta esperando, el
 * checkpoint antes del efecto, la aprobación de un solo uso y la supervivencia a un reinicio.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeSessionIndex, fakeSshPath, indexRow, waitFor } from '@jarvis/testkit';
import { defaultSshConfig, sshExec } from '@jarvis/agent-adapters';
import type { Approval, Plan, PlanStep } from '@jarvis/contracts';
import { buildApp } from '../../apps/core/src/app.js';
import { buildServices, type CoreServices } from '../../apps/core/src/services.js';
import { openDatabase } from '../../apps/core/src/platform/db.js';
import { ScriptedModel } from '../../apps/core/src/assistant/model.js';
import type { FastifyInstance } from 'fastify';

const root = mkdtempSync(join(tmpdir(), 'jarvis-plan-'));
process.env['JARVIS_FAKE_SSH_ROOT'] = join(root, 'fake-ssh');
const INTERNAL_SECRET = process.env['JARVIS_INTERNAL_SECRET'] as string;
const dbPath = join(root, 'core.db');

interface Harness { services: CoreServices; app: FastifyInstance }

async function boot(): Promise<Harness> {
  const services = buildServices({
    db: openDatabase({ path: dbPath }),
    index: new FakeSessionIndex([indexRow()]) as never,
    model: new ScriptedModel({ maxSteps: 2 }),
    config: {
      hosts: ['bastion'],
      bastionHost: 'bastion',
      sshCommand: fakeSshPath(),
      knownHostsFile: '',
      spoolRoot: join(root, 'spool'),
      pollIntervalMs: 200,
      planIntervalMs: 300,
      internalSecret: INTERNAL_SECRET,
    },
  });
  const app = buildApp({ services, trustAllIdentities: true });
  await app.ready();
  await services.supervisor.start();
  services.planSupervisor.start();
  return { services, app };
}

async function shutdown(harness: Harness): Promise<void> {
  harness.services.supervisor.stop();
  harness.services.planSupervisor.stop();
  await harness.app.close();
  harness.services.close();
}

let harness: Harness;
beforeEach(async () => { harness = await boot(); });
afterEach(async () => { await shutdown(harness); });

afterAll(async () => {
  const config = defaultSshConfig({ sshCommand: fakeSshPath(), hosts: ['bastion'], knownHostsFile: '' });
  await sshExec({ host: 'bastion', command: 'tmux kill-server 2>/dev/null || true', config }).catch(() => undefined);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
});

async function openWorkspace(app: FastifyInstance, sessionId = 'sid-plan'): Promise<string> {
  const response = await app.inject({
    method: 'POST', url: '/api/workspaces',
    payload: { ref: { host: 'bastion', provider: 'claude', sessionId } },
  });
  return (response.json() as { workspace: { id: string } }).workspace.id;
}

const planOf = async (app: FastifyInstance, planId: string) =>
  (await app.inject({ method: 'GET', url: `/api/plans/${planId}` }))
    .json<{ plan: Plan; steps: PlanStep[]; approvals: Approval[] }>();

describe('M4 · un objetivo se convierte en pasos', () => {
  it('crea el plan, ejecuta los runs y cierra con una síntesis', async () => {
    const workspaceId = await openWorkspace(harness.app);
    const created = await harness.app.inject({
      method: 'POST', url: '/api/plans',
      payload: { workspaceId, objective: 'averigua por que el pool se queda sin conexiones' },
    });
    expect(created.statusCode).toBe(202);
    const { plan } = created.json<{ plan: Plan }>();
    expect(plan.status).toBe('ready');

    const finished = await waitFor(
      () => planOf(harness.app, plan.id),
      (value) => value.plan.status === 'completed',
      { what: 'que el plan termine', timeoutMs: 60_000 },
    );
    expect(finished.plan.summary).toContain('2 pasos');

    // Dos runs de verdad y una síntesis, en orden y cada uno con su checkpoint.
    const runSteps = finished.steps.filter((step) => step.kind === 'run');
    expect(runSteps).toHaveLength(2);
    for (const step of runSteps) {
      expect(step.status).toBe('completed');
      expect(step.runId).toBeTruthy();
      expect(harness.services.runs.require(step.runId as string).status).toBe('completed');
    }
    expect(finished.steps.at(-1)?.kind).toBe('synthesis');

    // La clave de idempotencia es del paso, no de la ejecución: repetir no duplica.
    expect(new Set(finished.steps.map((step) => step.idempotencyKey)).size).toBe(finished.steps.length);
  });

  /**
   * `advance` se llama desde el supervisor, desde crear el plan y desde resolver una aprobación, y
   * dentro espera al modelo. Si dos turnos entran a la vez ven el mismo historial y proponen el
   * mismo paso dos veces: el plan acaba con un paso que nadie pidió.
   */
  it('dos avances simultáneos son un solo turno', async () => {
    const workspaceId = await openWorkspace(harness.app, 'sid-turnos');
    const user = { userId: 'u-test', username: 'tester' };
    const plan = harness.services.plans.create({
      workspaceId, objective: 'averigua por que el pool se queda sin conexiones', user,
    });

    await Promise.all([
      harness.services.plans.advance(plan.id, user),
      harness.services.plans.advance(plan.id, user),
      harness.services.plans.advance(plan.id, user),
    ]);

    const steps = harness.services.plans.steps(plan.id);
    expect(steps.filter((step) => step.ordinal === 0)).toHaveLength(1);
    expect(new Set(steps.map((step) => step.idempotencyKey)).size).toBe(steps.length);
  });

  it('el plan sobrevive a un reinicio del core y continúa donde estaba', async () => {
    const workspaceId = await openWorkspace(harness.app, 'sid-restart');
    const { plan } = (await harness.app.inject({
      method: 'POST', url: '/api/plans',
      payload: { workspaceId, objective: '@@slow:4 revisa el despliegue entero' },
    })).json<{ plan: Plan }>();

    // Se espera a que haya un run en marcha y entonces se mata el core.
    await waitFor(() => planOf(harness.app, plan.id), (value) => value.plan.status === 'waiting_run', {
      what: 'que el plan esté esperando a un run',
    });
    const before = await planOf(harness.app, plan.id);
    const firstRunId = before.steps[0]?.runId;
    expect(firstRunId).toBeTruthy();

    await shutdown(harness);
    harness = await boot();

    const after = await waitFor(
      () => planOf(harness.app, plan.id),
      (value) => value.plan.status === 'completed',
      { what: 'que el plan termine tras el reinicio', timeoutMs: 90_000 },
    );
    // El primer paso es el mismo run: no se relanzó nada al arrancar de nuevo.
    expect(after.steps[0]?.runId).toBe(firstRunId);
    expect(after.steps.filter((step) => step.kind === 'run')).toHaveLength(2);
  });
});

/**
 * M4-04/05/06/11: el coordinador no es sólo un generador de texto.
 *
 * Mira el contexto con las herramientas del core, deja ofrecida una terminal en vez de abrirla, y
 * cierra citando la evidencia por id en lugar de copiar la salida de los runs.
 */
describe('M4 · el Assistant usa las herramientas del core', () => {
  it('consulta, ofrece terminal y cierra con evidencia enlazada', async () => {
    const workspaceId = await openWorkspace(harness.app, 'sid-tools');
    const { plan } = (await harness.app.inject({
      method: 'POST', url: '/api/plans',
      payload: { workspaceId, objective: '@@tools revisa el pool de conexiones' },
    })).json<{ plan: Plan }>();

    const finished = await waitFor(
      () => planOf(harness.app, plan.id),
      (value) => value.plan.status === 'completed',
      { what: 'que el plan termine', timeoutMs: 60_000 },
    );

    const synthesis = finished.steps.at(-1) as PlanStep;
    expect(synthesis.kind).toBe('synthesis');
    const output = synthesis.output as {
      summary: string;
      evidence: Array<{ runId: string; status: string; summary: string | null }>;
      terminalOffer?: { host: string; provider: string; sessionId: string; permissionProfile: string };
    };

    // La evidencia son referencias a los trabajos, no sus buffers.
    const runIds = finished.steps.filter((step) => step.runId).map((step) => step.runId);
    expect(output.evidence.map((item) => item.runId)).toEqual(runIds);
    expect(output.evidence.every((item) => item.status === 'completed')).toBe(true);

    // La terminal quedó ofrecida sobre esta sesión; abrirla es cosa de la persona.
    expect(output.terminalOffer).toMatchObject({
      host: 'bastion', provider: 'claude', sessionId: 'sid-tools', permissionProfile: 'safe',
    });
    const terminals = await harness.services.terminal.list('bastion');
    expect(terminals.some((session) => session.name.includes('sid-tools'))).toBe(false);
  });
});

/**
 * M4-10: una respuesta humana reanuda **el paso** que la esperaba.
 *
 * El fallo que esto cubre no era visible desde fuera: el plan preguntaba, la persona contestaba y
 * el contexto del modelo seguía diciendo que no había respuesta pendiente. El plan continuaba,
 * pero a ciegas.
 */
describe('M4 · waiting_input', () => {
  it('lo que contesta la persona llega al siguiente paso', async () => {
    const workspaceId = await openWorkspace(harness.app, 'sid-input');
    const { plan } = (await harness.app.inject({
      method: 'POST', url: '/api/plans',
      payload: { workspaceId, objective: '@@ask arregla el pool' },
    })).json<{ plan: Plan }>();

    const asking = await waitFor(() => planOf(harness.app, plan.id),
      (value) => value.plan.status === 'waiting_input', { what: 'que pregunte' });
    const question = asking.steps.find((step) => step.kind === 'input');
    expect((question?.input as { question: string }).question).toContain('staging');

    const answered = await harness.app.inject({
      method: 'POST', url: `/api/plans/${plan.id}/input`, payload: { answer: 'staging' },
    });
    expect(answered.statusCode).toBe(200);

    const finished = await waitFor(() => planOf(harness.app, plan.id),
      (value) => value.plan.status === 'completed', { what: 'que termine', timeoutMs: 60_000 });

    const afterAnswer = finished.steps.find((step) => step.kind === 'run');
    expect(afterAnswer?.title).toBe('Trabajar en staging');
    // Y la respuesta queda en el historial del plan, no sólo en el turno que la usó.
    const inputStep = finished.steps.find((step) => step.kind === 'input');
    expect((inputStep?.output as { answer: string }).answer).toBe('staging');
  });
});

describe('M4 · aprobaciones', () => {
  it('una acción con efectos espera permiso, y aprobarla la ejecuta una sola vez', async () => {
    const workspaceId = await openWorkspace(harness.app, 'sid-approve');
    const { plan } = (await harness.app.inject({
      method: 'POST', url: '/api/plans',
      payload: { workspaceId, objective: '@@approval aplica el arreglo en el pool' },
    })).json<{ plan: Plan }>();

    const waiting = await waitFor(
      () => planOf(harness.app, plan.id),
      (value) => value.plan.status === 'waiting_approval',
      { what: 'que pida aprobación' },
    );
    const approval = waiting.approvals[0] as Approval;
    expect(approval.status).toBe('pending');
    // La tarjeta dice qué, dónde y con qué permiso: eso es lo que se autoriza.
    expect(approval.summary).toContain('escritura');
    expect((approval.target as { permissionProfile: string }).permissionProfile).toBe('auto');
    expect(approval.actionDigest).toMatch(/^[a-f0-9]{64}$/);

    const granted = await harness.app.inject({
      method: 'POST', url: `/api/approvals/${approval.id}`, payload: { decision: 'approved' },
    });
    expect(granted.statusCode).toBe(200);

    const finished = await waitFor(
      () => planOf(harness.app, plan.id),
      (value) => value.plan.status === 'completed',
      { what: 'que termine tras aprobar', timeoutMs: 60_000 },
    );
    const approvalStep = finished.steps.find((step) => step.approvalId === approval.id);
    expect(approvalStep?.runId).toBeTruthy();
    // La aprobación queda consumida: no sirve para una segunda ejecución.
    expect(harness.services.plans.approval(approval.id)?.status).toBe('consumed');

    const again = await harness.app.inject({
      method: 'POST', url: `/api/approvals/${approval.id}`, payload: { decision: 'approved' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json<{ error: { code: string } }>().error.code).toBe('APPROVAL_CONSUMED');
  });

  it('rechazar cierra el plan sin ejecutar nada', async () => {
    const workspaceId = await openWorkspace(harness.app, 'sid-reject');
    const { plan } = (await harness.app.inject({
      method: 'POST', url: '/api/plans',
      payload: { workspaceId, objective: '@@approval borra la base de datos' },
    })).json<{ plan: Plan }>();

    const waiting = await waitFor(() => planOf(harness.app, plan.id),
      (value) => value.plan.status === 'waiting_approval', { what: 'la aprobación' });
    const approval = waiting.approvals[0] as Approval;

    await harness.app.inject({
      method: 'POST', url: `/api/approvals/${approval.id}`, payload: { decision: 'rejected' },
    });

    const finished = await waitFor(() => planOf(harness.app, plan.id),
      (value) => value.plan.status === 'cancelled', { what: 'que se cierre el plan' });
    expect(finished.plan.summary).toContain('no autorizó');
    // Ningún run salió de ese paso.
    expect(finished.steps.every((step) => step.runId === null)).toBe(true);
  });

  it('una aprobación caducada no ejecuta', async () => {
    const workspaceId = await openWorkspace(harness.app, 'sid-expire');
    const { plan } = (await harness.app.inject({
      method: 'POST', url: '/api/plans',
      payload: { workspaceId, objective: '@@approval toca produccion' },
    })).json<{ plan: Plan }>();

    const waiting = await waitFor(() => planOf(harness.app, plan.id),
      (value) => value.plan.status === 'waiting_approval', { what: 'la aprobación' });
    const approval = waiting.approvals[0] as Approval;

    // Se envejece la aprobación como lo haría el tiempo.
    harness.services.db.prepare('UPDATE approvals SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), approval.id);

    const late = await harness.app.inject({
      method: 'POST', url: `/api/approvals/${approval.id}`, payload: { decision: 'approved' },
    });
    expect(late.statusCode).toBe(409);
    expect(late.json<{ error: { code: string } }>().error.code).toBe('APPROVAL_EXPIRED');

    const finished = await waitFor(() => planOf(harness.app, plan.id),
      (value) => ['failed', 'cancelled'].includes(value.plan.status), { what: 'que el plan se cierre' });
    expect(finished.plan.summary).toContain('caducó');
  });
});
