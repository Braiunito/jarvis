/**
 * Planes del Assistant: lineales, con checkpoint y despertar durable.
 *
 * El modelo propone el siguiente paso; el core lo persiste **antes** de ejecutarlo y sólo avanza
 * `current_step` cuando el efecto está confirmado. Si el proceso muere en cualquier punto, la
 * clave de idempotencia del paso decide si hay que observar un efecto que ya ocurrió o ejecutar
 * uno nuevo. Ninguna llamada de modelo se queda abierta esperando horas.
 */
import { createHash } from 'node:crypto';
import type { Database as Db } from 'better-sqlite3';
import type {
  Approval, Plan, PlanStep, PlanStatus, Run, UserIdentity,
} from '@jarvis/contracts';
import { isTerminalStatus, JarvisError } from '@jarvis/contracts';
import type { Clock } from '../platform/clock.js';
import { newApprovalId, newPlanId, newStepId } from '../platform/ids.js';
import type { AuditLog } from '../platform/audit.js';
import type { RunService } from '../runs/service.js';
import type { WorkspaceService } from '../workspaces/use-cases.js';
import type { AssistantModel, PlanContext } from '../assistant/model.js';

interface PlanRow {
  id: string; workspace_id: string; created_by: string; objective: string; status: string;
  current_step: number; created_at: string; updated_at: string; finished_at: string | null; summary: string | null;
}

interface StepRow {
  id: string; plan_id: string; ordinal: number; kind: string; status: string; title: string;
  input_json: string; output_json: string | null; run_id: string | null; approval_id: string | null;
  idempotency_key: string; attempt: number; available_at: string | null; started_at: string | null;
  finished_at: string | null; error_code: string | null;
}

interface ApprovalRow {
  id: string; plan_id: string | null; run_id: string | null; action_type: string; target_json: string;
  action_digest: string; summary: string; requested_by: string; requested_at: string; expires_at: string;
  status: string; resolved_by: string | null; resolved_at: string | null; consumed_at: string | null;
}

const toPlan = (row: PlanRow): Plan => ({
  id: row.id,
  workspaceId: row.workspace_id,
  createdBy: row.created_by,
  objective: row.objective,
  status: row.status as PlanStatus,
  currentStep: row.current_step,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  finishedAt: row.finished_at,
  summary: row.summary,
});

const toStep = (row: StepRow): PlanStep => ({
  id: row.id,
  planId: row.plan_id,
  ordinal: row.ordinal,
  kind: row.kind as PlanStep['kind'],
  status: row.status as PlanStatus,
  title: row.title,
  input: JSON.parse(row.input_json) as unknown,
  output: row.output_json ? JSON.parse(row.output_json) as unknown : null,
  runId: row.run_id,
  approvalId: row.approval_id,
  idempotencyKey: row.idempotency_key,
  attempt: row.attempt,
  availableAt: row.available_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  errorCode: row.error_code,
});

const toApproval = (row: ApprovalRow): Approval => ({
  id: row.id,
  planId: row.plan_id,
  runId: row.run_id,
  actionType: row.action_type,
  target: JSON.parse(row.target_json) as unknown,
  actionDigest: row.action_digest,
  summary: row.summary,
  requestedBy: row.requested_by,
  requestedAt: row.requested_at,
  expiresAt: row.expires_at,
  status: row.status as Approval['status'],
  resolvedBy: row.resolved_by,
  resolvedAt: row.resolved_at,
  consumedAt: row.consumed_at,
});

export interface PlanServiceDeps {
  db: Db;
  clock: Clock;
  runs: RunService;
  workspaces: WorkspaceService;
  model: AssistantModel | null;
  audit: AuditLog;
  approvalTtlMs?: number;
  maxSteps?: number;
}

export class PlanService {
  readonly #deps: PlanServiceDeps;
  readonly #approvalTtlMs: number;
  readonly #maxSteps: number;

  constructor(deps: PlanServiceDeps) {
    this.#deps = deps;
    this.#approvalTtlMs = deps.approvalTtlMs ?? 30 * 60 * 1000;
    this.#maxSteps = deps.maxSteps ?? 12;
  }

  get hasModel(): boolean { return this.#deps.model !== null; }

  // ---- consulta -----------------------------------------------------------

  find(planId: string): Plan | null {
    const row = this.#deps.db.prepare('SELECT * FROM plans WHERE id = ?').get(planId) as PlanRow | undefined;
    return row ? toPlan(row) : null;
  }

  require(planId: string): Plan {
    const plan = this.find(planId);
    if (!plan) throw new JarvisError('NOT_FOUND', `unknown plan ${planId}`, { scope: { planId } });
    return plan;
  }

  steps(planId: string): PlanStep[] {
    return (this.#deps.db.prepare('SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY ordinal')
      .all(planId) as StepRow[]).map(toStep);
  }

  approval(approvalId: string): Approval | null {
    const row = this.#deps.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as ApprovalRow | undefined;
    return row ? toApproval(row) : null;
  }

  listByWorkspace(workspaceId: string, limit = 20): Plan[] {
    return (this.#deps.db.prepare('SELECT * FROM plans WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(workspaceId, limit) as PlanRow[]).map(toPlan);
  }

  listActive(): Plan[] {
    return (this.#deps.db.prepare(
      "SELECT * FROM plans WHERE status NOT IN ('completed','failed','cancelled') ORDER BY updated_at",
    ).all() as PlanRow[]).map(toPlan);
  }

  pendingApprovals(): Approval[] {
    return (this.#deps.db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY requested_at")
      .all() as ApprovalRow[]).map(toApproval);
  }

  // ---- creación -----------------------------------------------------------

  create({ workspaceId, objective, user }: { workspaceId: string; objective: string; user: UserIdentity }): Plan {
    if (!this.#deps.model) {
      throw new JarvisError('CONFLICT',
        'no hay modelo configurado para el Assistant: fija JARVIS_MODEL_API_KEY en el core');
    }
    this.#deps.workspaces.require(workspaceId);
    if (!objective.trim()) throw new JarvisError('BAD_REQUEST', 'el objetivo no puede estar vacío');

    const at = this.#deps.clock.nowIso();
    const plan: Plan = {
      id: newPlanId(),
      workspaceId,
      createdBy: user.username,
      objective,
      status: 'ready',
      currentStep: 0,
      createdAt: at,
      updatedAt: at,
      finishedAt: null,
      summary: null,
    };
    this.#deps.db.prepare(`INSERT INTO plans
      (id, workspace_id, created_by, objective, status, current_step, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'ready', 0, ?, ?)`)
      .run(plan.id, workspaceId, user.username, objective, at, at);

    this.#deps.audit.record({
      actorUser: user.username, eventType: 'plan.created', workspaceId,
      payload: { planId: plan.id, objectiveBytes: Buffer.byteLength(objective, 'utf8') },
    });
    return plan;
  }

  // ---- motor --------------------------------------------------------------

  /**
   * Avanza un plan lo que se pueda sin bloquearse.
   *
   * Devuelve el plan tal como quedó. Es seguro llamarlo de más: cada estado sabe si le toca hacer
   * algo o esperar, y los efectos van con clave de idempotencia.
   */
  async advance(planId: string, user: UserIdentity): Promise<Plan> {
    const plan = this.require(planId);
    if (['completed', 'failed', 'cancelled'].includes(plan.status)) return plan;

    const steps = this.steps(planId);
    const current = steps.find((step) => !['completed', 'failed', 'cancelled'].includes(step.status));

    if (current) {
      const resolved = await this.#resolveStep(plan, current, user);
      if (!resolved) return this.require(planId); // sigue esperando
    }

    if (this.steps(planId).length >= this.#maxSteps) {
      return this.#finish(planId, 'failed', `el plan superó el límite de ${this.#maxSteps} pasos`);
    }
    return this.#proposeNext(planId, user);
  }

  /** @returns true si el paso quedó resuelto y el plan puede continuar. */
  async #resolveStep(plan: Plan, step: PlanStep, user: UserIdentity): Promise<boolean> {
    const { db, clock, runs } = this.#deps;

    // Un paso de aprobación ya autorizado espera a su run igual que un paso de run.
    if (step.runId) {
      const run = runs.find(step.runId);
      if (!run || !isTerminalStatus(run.status)) {
        this.#setPlanStatus(plan.id, 'waiting_run');
        return false;
      }
      const ok = run.status === 'completed';
      this.#completeStep(step.id, ok ? 'completed' : 'failed', {
        runId: run.id,
        status: run.status,
        summary: run.resultSummary ?? run.errorMessage ?? null,
      });
      if (!ok) {
        this.#finish(plan.id, 'failed', `el paso «${step.title}» terminó en ${run.status}`);
        return false;
      }
      return true;
    }

    if (step.kind === 'approval' && step.approvalId) {
      const approval = this.approval(step.approvalId);
      if (!approval) {
        this.#completeStep(step.id, 'failed', { error: 'approval missing' });
        this.#finish(plan.id, 'failed', 'la aprobación desapareció');
        return false;
      }
      if (approval.status === 'pending') {
        // Una aprobación caducada no ejecuta: se cierra sola y el plan lo dice.
        if (Date.parse(approval.expiresAt) <= clock.nowMs()) {
          db.prepare("UPDATE approvals SET status = 'expired' WHERE id = ?").run(approval.id);
          this.#completeStep(step.id, 'failed', { error: 'approval expired' });
          this.#finish(plan.id, 'failed', 'la aprobación caducó sin respuesta');
          return false;
        }
        this.#setPlanStatus(plan.id, 'waiting_approval');
        return false;
      }
      if (approval.status === 'expired') {
        this.#completeStep(step.id, 'failed', { status: approval.status });
        this.#finish(plan.id, 'failed', 'la aprobación caducó sin respuesta');
        return false;
      }
      if (approval.status !== 'approved') {
        this.#completeStep(step.id, 'cancelled', { status: approval.status });
        this.#finish(plan.id, 'cancelled', 'la persona no autorizó la acción');
        return false;
      }
      // Aprobada: se consume y se lanza el run que autorizaba, con la clave del paso.
      const input = step.input as { prompt: string; permissionProfile: PlanStep['kind'] extends never ? never : 'safe' | 'auto' | 'yolo' };
      const consumed = db.prepare("UPDATE approvals SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'approved'")
        .run(clock.nowIso(), approval.id);
      if (consumed.changes === 0) {
        this.#completeStep(step.id, 'failed', { error: 'approval already consumed' });
        this.#finish(plan.id, 'failed', 'esa aprobación ya se había usado');
        return false;
      }
      const created = await runs.create({
        workspaceId: plan.workspaceId,
        prompt: input.prompt,
        permissionProfile: input.permissionProfile,
        idempotencyKey: step.idempotencyKey,
      }, user, `plan:${plan.id}`);
      db.prepare("UPDATE plan_steps SET run_id = ?, status = 'waiting_run' WHERE id = ?")
        .run(created.run.id, step.id);
      db.prepare("UPDATE approvals SET run_id = ? WHERE id = ?").run(created.run.id, approval.id);
      this.#setPlanStatus(plan.id, 'waiting_run');
      return false;
    }

    if (step.kind === 'input') {
      const output = step.output as { answer?: string } | null;
      if (!output?.answer) {
        this.#setPlanStatus(plan.id, 'waiting_input');
        return false;
      }
      this.#completeStep(step.id, 'completed', output);
      return true;
    }

    return true;
  }

  /** Pide al modelo el siguiente paso y lo persiste **antes** de ejecutar nada. */
  async #proposeNext(planId: string, user: UserIdentity): Promise<Plan> {
    const { db, clock, runs, model } = this.#deps;
    if (!model) return this.#finish(planId, 'failed', 'no hay modelo configurado');

    const plan = this.require(planId);
    const workspace = this.#deps.workspaces.require(plan.workspaceId);
    const steps = this.steps(planId);

    const context: PlanContext = {
      objective: plan.objective,
      workspace: {
        id: workspace.id,
        host: workspace.ref.host,
        provider: workspace.ref.provider,
        sessionId: workspace.ref.sessionId,
        cwd: workspace.cwd,
      },
      // Resúmenes, no buffers: el contexto del modelo no puede crecer con cada línea de salida.
      history: steps.map((step) => ({
        ordinal: step.ordinal,
        kind: step.kind,
        title: step.title,
        status: step.status,
        summary: (step.output as { summary?: string } | null)?.summary ?? null,
      })),
      pendingInput: null,
    };

    this.#setPlanStatus(planId, 'running');
    let decision;
    try {
      decision = await model.decide(context);
    } catch (error) {
      return this.#finish(planId, 'failed', `el modelo falló: ${(error as Error).message}`);
    }

    const ordinal = steps.length;
    const at = clock.nowIso();
    const stepId = newStepId();
    // La clave se deriva del plan y del ordinal: repetir este paso tras un reinicio no puede
    // producir un segundo run.
    const idempotencyKey = `plan:${planId}:${ordinal}`;

    if (decision.kind === 'finish') {
      db.prepare(`INSERT INTO plan_steps
        (id, plan_id, ordinal, kind, status, title, input_json, output_json, idempotency_key, attempt, finished_at)
        VALUES (?, ?, ?, 'synthesis', 'completed', ?, ?, ?, ?, 1, ?)`)
        .run(stepId, planId, ordinal, 'Síntesis', JSON.stringify({}), JSON.stringify({ summary: decision.summary }), idempotencyKey, at);
      return this.#finish(planId, 'completed', decision.summary);
    }

    if (decision.kind === 'ask') {
      db.prepare(`INSERT INTO plan_steps
        (id, plan_id, ordinal, kind, status, title, input_json, idempotency_key, attempt)
        VALUES (?, ?, ?, 'input', 'waiting_input', ?, ?, ?, 1)`)
        .run(stepId, planId, ordinal, decision.title, JSON.stringify({ question: decision.question }), idempotencyKey);
      this.#setPlanStatus(planId, 'waiting_input');
      return this.require(planId);
    }

    if (decision.kind === 'approval') {
      const approvalId = newApprovalId();
      const target = {
        workspaceId: plan.workspaceId,
        host: workspace.ref.host,
        provider: workspace.ref.provider,
        permissionProfile: decision.permissionProfile,
        prompt: decision.prompt,
      };
      // El digest cubre acción, destino, permiso y comando: cambiar cualquiera invalida el
      // permiso que se concedió.
      const digest = createHash('sha256')
        .update(JSON.stringify({ actionType: decision.actionType, target })).digest('hex');
      db.prepare(`INSERT INTO approvals
        (id, plan_id, action_type, target_json, action_digest, summary, requested_by, requested_at, expires_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
        .run(approvalId, planId, decision.actionType, JSON.stringify(target), digest, decision.summary,
          plan.createdBy, at, new Date(clock.nowMs() + this.#approvalTtlMs).toISOString());
      db.prepare(`INSERT INTO plan_steps
        (id, plan_id, ordinal, kind, status, title, input_json, approval_id, idempotency_key, attempt)
        VALUES (?, ?, ?, 'approval', 'waiting_approval', ?, ?, ?, ?, 1)`)
        .run(stepId, planId, ordinal, decision.title,
          JSON.stringify({ prompt: decision.prompt, permissionProfile: decision.permissionProfile }),
          approvalId, idempotencyKey);
      this.#setPlanStatus(planId, 'waiting_approval');
      this.#deps.audit.record({
        actorUser: plan.createdBy, eventType: 'approval.requested', workspaceId: plan.workspaceId,
        payload: { planId, approvalId, actionType: decision.actionType, permissionProfile: decision.permissionProfile },
      });
      return this.require(planId);
    }

    // Un run: se persiste el paso antes de crearlo, para que un reinicio a mitad encuentre el
    // checkpoint y no una ejecución huérfana.
    db.prepare(`INSERT INTO plan_steps
      (id, plan_id, ordinal, kind, status, title, input_json, idempotency_key, attempt, started_at)
      VALUES (?, ?, ?, 'run', 'running', ?, ?, ?, 1, ?)`)
      .run(stepId, planId, ordinal, decision.title,
        JSON.stringify({ prompt: decision.prompt, permissionProfile: decision.permissionProfile, rationale: decision.rationale }),
        idempotencyKey, at);

    try {
      const created = await runs.create({
        workspaceId: plan.workspaceId,
        prompt: decision.prompt,
        permissionProfile: decision.permissionProfile,
        idempotencyKey,
      }, user, `plan:${planId}`);
      db.prepare("UPDATE plan_steps SET run_id = ?, status = 'waiting_run' WHERE id = ?")
        .run(created.run.id, stepId);
      this.#setPlanStatus(planId, 'waiting_run');
    } catch (error) {
      const message = (error as Error).message;
      db.prepare("UPDATE plan_steps SET status = 'failed', error_code = ?, finished_at = ? WHERE id = ?")
        .run('RUN_REJECTED', clock.nowIso(), stepId);
      return this.#finish(planId, 'failed', `no se pudo crear el trabajo: ${message}`);
    }
    return this.require(planId);
  }

  // ---- intervención humana ------------------------------------------------

  resolveApproval(approvalId: string, decision: 'approved' | 'rejected', user: UserIdentity): Approval {
    const { db, clock } = this.#deps;
    const approval = this.approval(approvalId);
    if (!approval) throw new JarvisError('NOT_FOUND', `unknown approval ${approvalId}`);
    if (approval.status === 'consumed') {
      throw new JarvisError('APPROVAL_CONSUMED', 'esa aprobación ya se usó');
    }
    if (approval.status !== 'pending') {
      throw new JarvisError('CONFLICT', `la aprobación ya está ${approval.status}`);
    }
    if (Date.parse(approval.expiresAt) <= clock.nowMs()) {
      db.prepare("UPDATE approvals SET status = 'expired' WHERE id = ?").run(approvalId);
      throw new JarvisError('APPROVAL_EXPIRED', 'esa aprobación caducó; pide una nueva');
    }
    db.prepare('UPDATE approvals SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ?')
      .run(decision, user.username, clock.nowIso(), approvalId);
    this.#deps.audit.record({
      actorUser: user.username,
      eventType: decision === 'approved' ? 'approval.granted' : 'approval.rejected',
      payload: { approvalId, planId: approval.planId, digest: approval.actionDigest },
    });
    return this.approval(approvalId) as Approval;
  }

  provideInput(planId: string, answer: string, user: UserIdentity): Plan {
    const steps = this.steps(planId);
    const waiting = steps.find((step) => step.kind === 'input' && step.status === 'waiting_input');
    if (!waiting) throw new JarvisError('CONFLICT', 'ese plan no está esperando ninguna respuesta');
    this.#deps.db.prepare("UPDATE plan_steps SET output_json = ?, status = 'ready' WHERE id = ?")
      .run(JSON.stringify({ answer, by: user.username }), waiting.id);
    this.#setPlanStatus(planId, 'ready');
    return this.require(planId);
  }

  cancel(planId: string, user: UserIdentity): Plan {
    const plan = this.require(planId);
    if (['completed', 'failed', 'cancelled'].includes(plan.status)) return plan;
    // Un run ya lanzado se cancela por su propio camino: aquí sólo se cierra el plan.
    this.#deps.audit.record({ actorUser: user.username, eventType: 'plan.cancelled', payload: { planId } });
    return this.#finish(planId, 'cancelled', 'cancelado por el operador');
  }

  /** El run terminó: el plan que lo esperaba vuelve a estar listo. */
  onRunSettled(run: Run): string | null {
    const row = this.#deps.db.prepare("SELECT plan_id FROM plan_steps WHERE run_id = ? AND status = 'waiting_run'")
      .get(run.id) as { plan_id: string } | undefined;
    return row?.plan_id ?? null;
  }

  // ---- helpers ------------------------------------------------------------

  #setPlanStatus(planId: string, status: PlanStatus): void {
    this.#deps.db.prepare('UPDATE plans SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, this.#deps.clock.nowIso(), planId);
  }

  #completeStep(stepId: string, status: PlanStatus, output: unknown): void {
    this.#deps.db.prepare('UPDATE plan_steps SET status = ?, output_json = ?, finished_at = ? WHERE id = ?')
      .run(status, JSON.stringify(output), this.#deps.clock.nowIso(), stepId);
  }

  #finish(planId: string, status: PlanStatus, summary: string): Plan {
    const at = this.#deps.clock.nowIso();
    this.#deps.db.prepare('UPDATE plans SET status = ?, summary = ?, finished_at = ?, updated_at = ? WHERE id = ?')
      .run(status, summary, at, at, planId);
    return this.require(planId);
  }
}
