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
  Approval, Plan, PlanStep, PlanStatus, Run, UserIdentity, Workspace,
} from '@jarvis/contracts';
import { isTerminalStatus, JarvisError } from '@jarvis/contracts';
import type { Clock } from '../platform/clock.js';
import { newApprovalId, newPlanId, newStepId } from '../platform/ids.js';
import type { AuditLog } from '../platform/audit.js';
import type { AttachmentService } from '../attachments/service.js';
import type { EvidenceService } from '../evidence/service.js';
import type { RunService } from '../runs/service.js';
import type { WorkspaceService } from '../workspaces/use-cases.js';
import type { SessionService } from '../sessions/service.js';
import type { HealthService } from '../health/service.js';
import type {
  AssistantModel, EvidenceRef, PlanContext, PlanHistoryEntry,
} from '../assistant/model.js';
import { CoreAssistantToolbox, type ToolboxLimits } from '../assistant/toolbox.js';

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

/**
 * Lo que un paso ya dado le cuenta al modelo en una línea.
 *
 * Cada tipo de paso guarda su resultado de otra forma, y lo que importa es que ninguno se quede
 * mudo en el historial: un paso sin resumen es un paso que el modelo repite.
 */
function stepSummary(step: PlanStep): string | null {
  const output = step.output as Record<string, unknown> | null;
  if (!output) return null;
  if (typeof output['summary'] === 'string') return output['summary'];
  if (typeof output['answer'] === 'string') return `la persona respondió: ${output['answer']}`;
  if (typeof output['error'] === 'string') return `falló: ${output['error']}`;
  if (typeof output['status'] === 'string') return `la aprobación quedó ${output['status']}`;
  return null;
}

export interface PlanServiceDeps {
  db: Db;
  clock: Clock;
  runs: RunService;
  workspaces: WorkspaceService;
  /** Las herramientas de lectura del Assistant salen de estos mismos casos de uso, no de REST. */
  sessions: SessionService;
  health: HealthService;
  /** Para que el Assistant vea la evidencia que no es texto (TEC-06). Opcionales las dos. */
  attachments?: AttachmentService;
  evidence?: EvidenceService;
  model: AssistantModel | null;
  audit: AuditLog;
  approvalTtlMs?: number;
  maxSteps?: number;
  /** Cuántas consultas puede encadenar el modelo antes de tener que decidir algo. */
  maxToolCalls?: number;
  toolLimits?: Partial<ToolboxLimits>;
}

export class PlanService {
  readonly #deps: PlanServiceDeps;
  readonly #approvalTtlMs: number;
  readonly #maxSteps: number;
  readonly #maxToolCalls: number;
  /** Turnos en curso y turnos en cola, por plan. Ver `advance`. */
  readonly #running = new Map<string, Promise<Plan>>();
  readonly #queued = new Map<string, Promise<Plan>>();

  constructor(deps: PlanServiceDeps) {
    this.#deps = deps;
    this.#approvalTtlMs = deps.approvalTtlMs ?? 30 * 60 * 1000;
    this.#maxSteps = deps.maxSteps ?? 12;
    this.#maxToolCalls = deps.maxToolCalls ?? 6;
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
   *
   * **Los turnos de un plan se serializan.** Se llama desde cuatro sitios —el supervisor, crear el
   * plan, responder una pregunta y resolver una aprobación— y dentro hay dos esperas largas:
   * lanzar un run y preguntarle al modelo. Sin esta cola dos llamadas entran a la vez, las dos ven
   * el mismo historial y las dos proponen un paso; el plan acaba con un paso que nadie pidió y con
   * una llamada al modelo de más. Un turno esperando vale por todos los que lleguen mientras
   * espera, porque todos quieren lo mismo: que el plan avance después de lo que está pasando ahora.
   */
  advance(planId: string, user: UserIdentity): Promise<Plan> {
    const waiting = this.#queued.get(planId);
    if (waiting) return waiting;

    const running = this.#running.get(planId);
    if (!running) return this.#startTurn(planId, user);

    const queued = running.catch(() => undefined).then(() => {
      this.#queued.delete(planId);
      return this.#startTurn(planId, user);
    });
    this.#queued.set(planId, queued);
    return queued;
  }

  #startTurn(planId: string, user: UserIdentity): Promise<Plan> {
    const turn = this.#advanceOnce(planId, user);
    this.#running.set(planId, turn);
    const release = (): void => {
      if (this.#running.get(planId) === turn) this.#running.delete(planId);
    };
    turn.then(release, release);
    return turn;
  }

  async #advanceOnce(planId: string, user: UserIdentity): Promise<Plan> {
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

  /**
   * Pide al modelo el siguiente paso y lo persiste **antes** de ejecutar nada.
   *
   * El modelo recibe dos cosas: un paquete de contexto con resúmenes y referencias —nunca los
   * buffers de los runs— y unas herramientas para pedir lo que le falte. Lo que devuelve es una
   * decisión, y una decisión es un checkpoint.
   */
  async #proposeNext(planId: string, user: UserIdentity): Promise<Plan> {
    const { db, clock, runs, model, sessions, health, audit, toolLimits } = this.#deps;
    if (!model) return this.#finish(planId, 'failed', 'no hay modelo configurado');

    const plan = this.require(planId);
    const workspace = this.#deps.workspaces.require(plan.workspaceId);
    const steps = this.steps(planId);
    const context = this.#contextFor(plan, workspace, steps);

    // Las herramientas se construyen por turno y atadas a este plan: ninguna alcanza el trabajo de
    // otro workspace ni actúa como otra persona.
    const toolbox = new CoreAssistantToolbox({
      plan, workspace, sessions, health, runs, audit, user,
      // Lo que este plan ha lanzado, que es lo único que puede parar por su cuenta.
      ownRunIds: steps.map((step) => step.runId).filter((id): id is string => Boolean(id)),
      ...(this.#deps.attachments ? { attachments: this.#deps.attachments } : {}),
      ...(this.#deps.evidence ? { evidence: this.#deps.evidence } : {}),
      maxObservations: this.#maxToolCalls,
      ...(toolLimits ? { limits: toolLimits } : {}),
    });

    this.#setPlanStatus(planId, 'running');
    let decision;
    try {
      decision = await model.decide(context, toolbox);
    } catch (error) {
      return this.#finish(planId, 'failed', `el modelo falló: ${(error as Error).message}`);
    }

    const ordinal = steps.length;
    const at = clock.nowIso();
    const stepId = newStepId();
    // La clave se deriva del plan y del ordinal: repetir este paso tras un reinicio no puede
    // producir un segundo run.
    const idempotencyKey = `plan:${planId}:${ordinal}`;
    // Lo que el modelo dejó ofrecido viaja con el paso. Ofrecer no es hacer: la terminal la abre
    // la persona desde la interfaz, y si no la abre no ha pasado nada.
    const offer = toolbox.terminalOffer;
    const withOffer = (payload: Record<string, unknown>): Record<string, unknown> =>
      (offer ? { ...payload, terminalOffer: offer } : payload);

    if (decision.kind === 'finish') {
      // La síntesis enlaza a la evidencia por id; el contenido sigue donde estaba (M4-11).
      const evidence = this.#evidenceFor(steps, decision.evidenceRunIds);
      db.prepare(`INSERT INTO plan_steps
        (id, plan_id, ordinal, kind, status, title, input_json, output_json, idempotency_key, attempt, finished_at)
        VALUES (?, ?, ?, 'synthesis', 'completed', ?, ?, ?, ?, 1, ?)`)
        .run(stepId, planId, ordinal, 'Síntesis', JSON.stringify({}),
          JSON.stringify(withOffer({ summary: decision.summary, evidence })), idempotencyKey, at);
      return this.#finish(planId, 'completed', decision.summary);
    }

    if (decision.kind === 'ask') {
      db.prepare(`INSERT INTO plan_steps
        (id, plan_id, ordinal, kind, status, title, input_json, idempotency_key, attempt)
        VALUES (?, ?, ?, 'input', 'waiting_input', ?, ?, ?, 1)`)
        .run(stepId, planId, ordinal, decision.title,
          JSON.stringify(withOffer({ question: decision.question })), idempotencyKey);
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
          JSON.stringify(withOffer({ prompt: decision.prompt, permissionProfile: decision.permissionProfile })),
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
        JSON.stringify(withOffer({
          prompt: decision.prompt, permissionProfile: decision.permissionProfile, rationale: decision.rationale,
        })),
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

  /**
   * El paquete de contexto (05 §10.3).
   *
   * Resúmenes, referencias y límites. Lo que el modelo quiera ver de verdad —el transcript de la
   * sesión, la salida de un run, la salud de un host— lo pide con una herramienta, acotado y sólo
   * cuando le hace falta. Reenviar buffers «por si acaso» es cómo un plan de cuatro pasos acaba
   * costando lo que uno de cuarenta.
   */
  #contextFor(plan: Plan, workspace: Workspace, steps: PlanStep[]): PlanContext {
    const history: PlanHistoryEntry[] = steps.map((step) => ({
      ordinal: step.ordinal,
      kind: step.kind,
      title: step.title,
      status: step.status,
      summary: stepSummary(step),
      runId: step.runId,
      errorCode: step.errorCode,
    }));

    // La respuesta de una persona es «pendiente» sólo mientras sea lo último que ha pasado. Después
    // sigue en el historial, pero ya no es una instrucción nueva que atender.
    const last = steps.at(-1);
    const pendingInput = last && last.kind === 'input' && last.status === 'completed'
      ? (last.output as { answer?: string } | null)?.answer ?? null
      : null;

    const pendingApprovals = steps
      .map((step) => (step.approvalId ? this.approval(step.approvalId) : null))
      .filter((approval): approval is Approval => approval !== null && approval.status === 'pending')
      .map((approval) => ({ id: approval.id, summary: approval.summary, expiresAt: approval.expiresAt }));

    return {
      objective: plan.objective,
      workspace: {
        id: workspace.id,
        host: workspace.ref.host,
        provider: workspace.ref.provider,
        sessionId: workspace.ref.sessionId,
        cwd: workspace.cwd,
        title: workspace.title,
      },
      history,
      pendingInput,
      pendingApprovals,
      limits: {
        stepsUsed: steps.length,
        maxSteps: this.#maxSteps,
        maxToolCalls: this.#maxToolCalls,
        maxToolOutputBytes: 60_000,
      },
    };
  }

  /**
   * Los trabajos que sostienen la síntesis.
   *
   * Si el modelo citó algunos, se respetan esos; si no citó ninguno, valen todos los del plan. Lo
   * que nunca se copia es la salida entera: va el resumen del run y su id, y la interfaz abre la
   * evidencia completa desde ahí.
   */
  #evidenceFor(steps: PlanStep[], cited?: string[]): EvidenceRef[] {
    const withRun = steps.filter((step) => step.runId !== null);
    const chosen = cited?.length
      ? withRun.filter((step) => cited.includes(step.runId as string))
      : withRun;
    return chosen.map((step) => {
      const runId = step.runId as string;
      const run = this.#deps.runs.find(runId);
      return {
        runId,
        title: step.title,
        status: run?.status ?? step.status,
        summary: run?.resultSummary ? run.resultSummary.slice(0, 600) : null,
      };
    });
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
