/**
 * Planes del Assistant: lineales, con checkpoint y despertar durable.
 *
 * El modelo propone el siguiente paso; el core lo persiste **antes** de ejecutarlo y sólo avanza
 * `current_step` cuando el efecto está confirmado. Si el proceso muere en cualquier punto, la
 * clave de idempotencia del paso decide si hay que observar un efecto que ya ocurrió o ejecutar
 * uno nuevo. Ninguna llamada de modelo se queda abierta esperando horas.
 */
import type { Database as Db } from 'better-sqlite3';
import type {
  Approval, AutonomyMode, Plan, PlanStep, PlanStatus, Run, UserIdentity, Workspace,
  WorkflowEnvelope,
} from '@jarvis/contracts';
import { autonomyOf, isTerminalStatus, JarvisError } from '@jarvis/contracts';
import type { Clock } from '../platform/clock.js';
import { newApprovalId, newPlanId, newStepId } from '../platform/ids.js';
import { approvalDigest, digestMatches } from '../platform/approvals.js';
import {
  applyRevision, digestOf, type DraftStep, MAX_STEP_OUTPUT_CHARS, outsideEnvelope,
  revisionOutsideEnvelope,
} from './workflow.js';
import type { AuditLog } from '../platform/audit.js';
import type { AttachmentService } from '../attachments/service.js';
import type { EvidenceService } from '../evidence/service.js';
import type { RunService } from '../runs/service.js';
import type { WorkspaceService } from '../workspaces/use-cases.js';
import type { SessionService } from '../sessions/service.js';
import type { HealthService } from '../health/service.js';
import type {
  AssistantDecision, AssistantModel, EvidenceRef, PlanContext, PlanHistoryEntry,
} from '../assistant/model.js';
import { CoreAssistantToolbox, type ToolboxLimits } from '../assistant/toolbox.js';
import type { McpService } from '../mcp/service.js';

interface PlanRow {
  id: string; workspace_id: string; created_by: string; objective: string; status: string;
  current_step: number; created_at: string; updated_at: string; finished_at: string | null; summary: string | null;
  /** El ordinal del paso que puede pensarse en la nube, si alguien lo autorizó. Ver `#proposeNext`. */
  escalate_for_step: number | null;
  /** Cuánta cuerda tiene el asistente en este plan. Ver la migración 15 y ADR-010. */
  autonomy: string;
  /** De qué conversación salió, si salió de una. Migración 17. */
  conversation_id: string | null;
  /** El perímetro firmado, si es un workflow. Migración 17. */
  envelope_json: string | null;
}

interface StepRow {
  id: string; plan_id: string; ordinal: number; kind: string; status: string; title: string;
  input_json: string; output_json: string | null; run_id: string | null; approval_id: string | null;
  idempotency_key: string; attempt: number; available_at: string | null; started_at: string | null;
  finished_at: string | null; error_code: string | null;
}

interface ApprovalRow {
  id: string; plan_id: string | null; conversation_id: string | null; run_id: string | null; action_type: string; target_json: string;
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
  autonomy: autonomyOf(row.autonomy),
  conversationId: row.conversation_id,
  envelope: row.envelope_json ? JSON.parse(row.envelope_json) as WorkflowEnvelope : null,
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
  conversationId: row.conversation_id,
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

/** En qué estados un plan ya no se mueve. Gobernarlo entonces no es gobernarlo, es reescribirlo. */
const TERMINALES = new Set(['completed', 'failed', 'cancelled']);

/**
 * La salida de un paso, en texto y acotada.
 *
 * Se dice que se recortó en vez de recortar en silencio: un modelo que recibe medio JSON sin
 * avisar se lo cree entero, y eso es peor que no dárselo.
 */
/**
 * Los pasos estimativos del plan, y en cuál se está.
 *
 * El modelo necesita ver el plan **entero** para atar el paso que le toca sin reinventar el
 * resto: sin esto sabría lo que ya pasó y lo que se le pide ahora, pero no hacia dónde va, que es
 * justo lo que hace que un paso encaje con el siguiente en vez de repetirlo.
 */
function plannedFrom(steps: PlanStep[]): NonNullable<PlanContext['plannedSteps']> {
  // El que toca es el primero sin atar. Derivarlo de los propios pasos evita tener un contador
  // aparte que pueda decir otra cosa que ellos.
  const actual = steps.find((step) => step.kind === 'estimate' && step.status === 'draft')?.ordinal;
  return steps
    .filter((step) => step.kind === 'estimate')
    .map((step) => {
      const input = (step.input ?? {}) as { intent?: string; expects?: string; unknowns?: string[]; writes?: boolean };
      return {
        ordinal: step.ordinal,
        title: step.title,
        intent: input.intent ?? '',
        expects: input.expects ?? '',
        unknowns: input.unknowns ?? [],
        writes: input.writes ?? false,
        state: step.status !== 'draft' ? 'done' as const
          : step.ordinal === actual ? 'current' as const
            : 'pending' as const,
      };
    });
}

function clipOutput(output: unknown): string | null {
  if (output === null || output === undefined) return null;
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  if (text.length <= MAX_STEP_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_STEP_OUTPUT_CHARS)}… (recortado, ${text.length} caracteres en total)`;
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
  /**
   * Las capacidades de sistema (ADR-009), de **sólo lectura** en un plan.
   *
   * Un plan puede mirar la máquina para decidir mejor —si el host está saturado, si el servicio
   * está caído—, pero no puede tocarla: aprobar en un plan lanza un run, y ése es el único efecto
   * que su motor sabe ejecutar. Lo que tenga efectos se pide desde una conversación.
   */
  mcp?: McpService;
  /** Si hay modelo de nube al que escalar. Sin él, la herramienta no se le ofrece al modelo. */
  canEscalate?: boolean;
  starterCapabilities?: readonly string[];
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

  /**
   * Los planes que están en marcha, para el contexto de la casa.
   *
   * Va aquí y no en una herramienta porque cuesta una consulta a SQLite y cero de red, igual que
   * los trabajos vivos. Y hay un motivo propio: sin esto, a «¿cómo va aquello?» el asistente
   * **propone otro plan** en vez de mirar el que ya está corriendo — no se equivoca, es que no
   * tiene forma de saber que existe.
   *
   * `draft` no cuenta: un borrador sin firmar no está en marcha, está esperando a que alguien lo
   * lea. Enseñarlo aquí haría que el asistente hablara de un plan que nadie aprobó como si fuera.
   */
  live(limit = 4): Array<{ planId: string; status: string; objective: string; step: number; steps: number }> {
    const rows = this.#deps.db.prepare(
      `SELECT p.id, p.status, p.objective, p.current_step,
              (SELECT count(*) FROM plan_steps s WHERE s.plan_id = p.id) AS steps
       FROM plans p
       WHERE p.status NOT IN ('completed','failed','cancelled','draft')
       ORDER BY p.updated_at DESC LIMIT ?`,
    ).all(limit) as Array<{ id: string; status: string; objective: string; current_step: number; steps: number }>;
    return rows.map((row) => ({
      planId: row.id,
      status: row.status,
      objective: row.objective,
      step: row.current_step,
      steps: row.steps,
    }));
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
      // Un plan creado por REST no es un workflow: nadie firmó un perímetro para él y no sale
      // de ninguna conversación. Lo que decide si se comprueba el sobre es tenerlo o no.
      autonomy: 'manual',
      conversationId: null,
      envelope: null,
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

  /**
   * Un workflow: el plan entero propuesto de golpe, con su perímetro, y sin avanzar todavía.
   *
   * Nace en `draft` y ahí se queda hasta que alguien lo firme. Ésa es la diferencia con
   * `create()`: un plan normal nace listo para pensar el primer paso, y un workflow nace **escrito
   * entero** para que se pueda leer antes de autorizarlo. Lo que se firma es el sobre, no la lista
   * de pasos, porque los pasos van a cambiar por diseño —para eso son estimativos— y no se puede
   * firmar algo que va a cambiar.
   *
   * Los pasos entran como `estimate`: dicen qué se quiere conseguir y qué falta por saber, y no
   * con qué se hará. Atarlos es trabajo del turno que llegue a cada uno.
   */
  createWorkflow(input: {
    /**
     * Sobre qué sesión trabaja, si trabaja sobre alguna.
     *
     * `null` es un workflow **de la casa** —«compara el disco de las tres máquinas»— que no
     * pertenece a ninguna sesión de agente. No puede lanzar trabajo: un run necesita un workspace
     * donde vivir, y eso se dice al llegar en vez de descubrirse a mitad.
     */
    workspaceId: string | null;
    objective: string;
    envelope: WorkflowEnvelope;
    steps: ReadonlyArray<DraftStep>;
    conversationId?: string | null;
    autonomy?: AutonomyMode;
    user: UserIdentity;
  }): Plan {
    const user = input.user;
    if (input.workspaceId) this.#deps.workspaces.require(input.workspaceId);
    if (!input.objective.trim()) throw new JarvisError('BAD_REQUEST', 'el objetivo no puede estar vacío');
    if (input.steps.length === 0) throw new JarvisError('BAD_REQUEST', 'un workflow sin pasos no es un plan');

    const at = this.#deps.clock.nowIso();
    const planId = newPlanId();
    const autonomy = input.autonomy ?? 'manual';
    const write = this.#deps.db.transaction(() => {
      this.#deps.db.prepare(`INSERT INTO plans
        (id, workspace_id, created_by, objective, status, current_step, created_at, updated_at,
         autonomy, conversation_id, envelope_json)
        VALUES (?, ?, ?, ?, 'draft', 0, ?, ?, ?, ?, ?)`)
        .run(planId, input.workspaceId ?? null, user.username, input.objective, at, at,
          autonomy, input.conversationId ?? null, JSON.stringify(input.envelope));

      input.steps.forEach((step, ordinal) => {
        this.#deps.db.prepare(`INSERT INTO plan_steps
          (id, plan_id, ordinal, kind, status, title, input_json, idempotency_key, attempt)
          VALUES (?, ?, ?, 'estimate', 'draft', ?, ?, ?, 1)`)
          .run(newStepId(), planId, ordinal, step.title,
            JSON.stringify({
              intent: step.intent,
              expects: step.expects,
              unknowns: step.unknowns ?? [],
              writes: step.writes ?? false,
            }),
            `plan:${planId}:${ordinal}`);
      });
    });
    write();

    this.#deps.audit.record({
      actorUser: user.username, eventType: 'workflow.drafted', workspaceId: input.workspaceId,
      payload: {
        planId, steps: input.steps.length, hosts: input.envelope.hosts,
        maxRuns: input.envelope.maxRuns, writes: input.envelope.writes,
      },
    });
    return this.require(planId);
  }

  /**
   * El workflow queda firmado y pasa a poder pensar.
   *
   * Se comprueba que el sobre es **el mismo** que se enseñó, comparando el digest: entre que se
   * propone y se firma cabe una revisión, y firmar un sobre para acabar ejecutando otro es
   * exactamente lo que el digest existe para impedir.
   */
  activate(planId: string, user: UserIdentity, signedDigest?: string): Plan {
    const plan = this.require(planId);
    if (plan.status !== 'draft') {
      throw new JarvisError('CONFLICT', `este plan ya no es un borrador: está ${plan.status}`);
    }
    if (!plan.envelope) throw new JarvisError('CONFLICT', 'este plan no tiene perímetro que firmar');

    /*
     * El digest se comprueba **si quien llama lo trae**.
     *
     * Cuando esto lo dispara una tarjeta firmada, la comprobación ya la hizo la aprobación con su
     * propio digest, que cubre el sobre entero. Repetirla aquí no sobra pero tampoco es lo que
     * sostiene la garantía; lo que no puede pasar es que sin digest se ejecute otro sobre, y por
     * eso el que se guarda es el que se enseñó.
     */
    const digest = digestOf({ planId, objective: plan.objective, envelope: plan.envelope });
    if (signedDigest !== undefined && digest !== signedDigest) {
      throw new JarvisError('CONFLICT',
        'lo que se firmó no es lo que hay: el plan cambió después de enseñarlo');
    }

    this.#setPlanStatus(planId, 'ready');
    this.#deps.audit.record({
      actorUser: user.username, eventType: 'workflow.activated', workspaceId: plan.workspaceId,
      payload: { planId, digest },
    });
    return this.require(planId);
  }

  /**
   * Corregir el plan en vuelo, y sólo hacia delante.
   *
   * Lo pide la conversación, nunca el propio plan: un plan que se corrigiera a sí mismo mientras
   * corre no tendría a quién enseñarle el cambio. Aquí hay alguien mirando.
   *
   * Un workflow se firma sabiendo que los pasos van a cambiar —para eso son estimativos— así que
   * revisarlos no invalida la firma. Lo que **no** puede hacer una revisión es ensanchar el
   * perímetro: si deja más pasos de los autorizados o mete uno que escribe donde se firmó sólo
   * mirar, deja de ser una corrección y pasa a ser un plan nuevo, que firma una persona.
   *
   * Los pasos ya hechos no se reescriben. La historia de un plan es lo que permite leer qué pasó,
   * y uno que reescribe su propio pasado no se puede auditar.
   */
  revise(input: {
    planId: string; reason: string; changes: ReadonlyArray<Record<string, unknown>>; user: UserIdentity;
  }): { ok: true } | { ok: false; message: string } {
    const { planId, user } = input;
    const plan = this.require(planId);
    const steps = this.steps(planId);
    /*
     * Desde dónde se puede corregir: el primer paso **sin atar**.
     *
     * No vale `plan.currentStep`. Ese contador dice por dónde va el motor, y tras atar el primer
     * paso puede seguir apuntando a un ordinal que ya está ocupado por un `run`: entonces el
     * borrado no se lo lleva —ya no es `draft`— pero la reinserción empieza ahí y choca contra él.
     * Sale un `UNIQUE constraint failed` en la cara de quien pidió una corrección, que además es
     * un error del sistema para algo que sólo era una petición imposible.
     *
     * Lo que manda son los propios pasos, igual que en `plannedFrom`: dos formas de calcular lo
     * mismo acaban diciendo cosas distintas.
     */
    const primeroSinAtar = steps.find((step) => step.kind === 'estimate' && step.status === 'draft');
    if (!primeroSinAtar) {
      return { ok: false, message: 'este workflow ya no tiene pasos por hacer: no hay nada que corregir' };
    }
    const desde = primeroSinAtar.ordinal;

    /*
     * No poder corregir se devuelve, no se lanza.
     *
     * Quien llama es un turno del modelo, y lo que necesita es una frase que pueda leer para
     * intentar otra cosa. Una excepción aquí sería un camino de error para algo que no es un
     * error: pedir una corrección imposible es una petición razonable con una respuesta clara.
     */
    const revision = applyRevision(steps, desde, input.changes as never);
    if (!revision.ok) {
      return {
        ok: false,
        message: revision.hint ? `${revision.message}. ${revision.hint}` : revision.message,
      };
    }

    const fuera = revisionOutsideEnvelope(plan.envelope, revision.steps);
    if (fuera) return { ok: false, message: fuera };

    const at = this.#deps.clock.nowIso();
    const rewrite = this.#deps.db.transaction(() => {
      this.#deps.db
        .prepare("DELETE FROM plan_steps WHERE plan_id = ? AND ordinal >= ? AND kind = 'estimate' AND status = 'draft'")
        .run(planId, desde);
      revision.steps.forEach((step, indice) => {
        this.#deps.db.prepare(`INSERT INTO plan_steps
          (id, plan_id, ordinal, kind, status, title, input_json, idempotency_key, attempt)
          VALUES (?, ?, ?, 'estimate', 'draft', ?, ?, ?, 1)`)
          .run(newStepId(), planId, desde + indice, step.title,
            JSON.stringify({
              intent: step.intent, expects: step.expects,
              unknowns: step.unknowns ?? [], writes: step.writes ?? false,
            }),
            `plan:${planId}:rev${desde}:${indice}`);
      });
      this.#deps.db.prepare('UPDATE plans SET updated_at = ? WHERE id = ?').run(at, planId);
    });
    rewrite();

    this.#deps.audit.record({
      actorUser: user.username, eventType: 'workflow.revised', workspaceId: plan.workspaceId,
      payload: { planId, from: desde, steps: revision.steps.length, reason: input.reason.slice(0, 300) },
    });
    return { ok: true };
  }

  /**
   * Pausar, reanudar o cancelar un workflow desde fuera.
   *
   * Cancelar **no deshace lo hecho**: los trabajos que ya corrieron corrieron, y decir lo
   * contrario sería mentir sobre una máquina. Lo que hace es que no se dé el paso siguiente.
   *
   * Pausar existe aparte de cancelar porque son dos intenciones distintas: «esto va mal, para» y
   * «esto va bien pero ahora no». Sin la segunda, la única forma de ganar tiempo es matar el plan.
   */
  steer(input: {
    planId: string; op: 'pause' | 'resume' | 'cancel'; reason: string; user: UserIdentity;
  }): { ok: true } | { ok: false; message: string } {
    const plan = this.require(input.planId);
    if (TERMINALES.has(plan.status)) {
      return { ok: false, message: `este plan ya terminó: está ${plan.status}` };
    }

    if (input.op === 'resume' && plan.status !== 'paused') {
      return { ok: false, message: `este plan no está pausado: está ${plan.status}` };
    }
    if (input.op === 'pause' && plan.status === 'paused') {
      return { ok: false, message: 'este plan ya estaba pausado' };
    }

    /*
     * Reanudar devuelve a `ready`, que es «le toca pensar».
     *
     * No se recupera el estado exacto que tenía al pausarse —si esperaba un run o una aprobación,
     * eso sigue esperando por su cuenta y el motor lo verá al mirar sus pasos—. Guardar «estaba
     * en waiting_run» para restaurarlo sería una segunda idea de en qué punto está el plan, que
     * es lo mismo que evitamos al no fingir la pausa.
     */
    const destino = input.op === 'cancel' ? 'cancelled' : input.op === 'pause' ? 'paused' : 'ready';
    this.#setPlanStatus(input.planId, destino);
    this.#deps.audit.record({
      actorUser: input.user.username,
      eventType: `workflow.${input.op}d`,
      workspaceId: plan.workspaceId,
      payload: { planId: input.planId, from: plan.status, reason: input.reason.slice(0, 300) },
    });
    return { ok: true };
  }

  /** Lo justo para contarlo en el hilo: qué se propuso, cuántos pasos y por dónde va. */
  describe(planId: string): { objective: string; steps: number; status: string } | null {
    const plan = this.#deps.db.prepare('SELECT objective, status FROM plans WHERE id = ?')
      .get(planId) as { objective: string; status: string } | undefined;
    if (!plan) return null;
    const steps = this.#deps.db.prepare('SELECT COUNT(*) n FROM plan_steps WHERE plan_id = ?')
      .get(planId) as { n: number };
    return { objective: plan.objective, steps: steps.n, status: plan.status };
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
    /*
     * Un borrador no se piensa: está esperando una firma, no un turno.
     *
     * `draft` es el estado en que nace un workflow propuesto, y el motor lo trataba como a
     * cualquier plan pendiente: el supervisor lo empujaba, `#proposeNext` lo pasaba a `running` y
     * le pedía una decisión al modelo. Visto en producción con un plan de siete pasos que nadie
     * había aprobado.
     *
     * Con autonomía `manual` el daño se quedaba en gastar modelo por algo que nadie autorizó. Con
     * `auto` es peor: el sobre ya existe, así que las comprobaciones del perímetro pasarían tan
     * ricamente, y un plan sin firmar lanzaría trabajo dentro de unos límites que tampoco firmó
     * nadie. Que el motor tratara un borrador como pendiente de pensar vaciaba de sentido la firma
     * entera.
     */
    if (plan.status === 'draft') return plan;

    const steps = this.steps(planId);
    /*
     * Cuál es el paso en curso, y por qué un estimativo sin atar no lo es.
     *
     * Un paso `estimate` en `draft` no está esperando nada del mundo —ni un run, ni una firma, ni
     * una respuesta—: está esperando a que alguien decida con qué se hace, y eso es precisamente
     * lo que va a hacer `#proposeNext`. Si se cuenta como paso en curso, `#resolveStep` no sabe
     * qué resolver, contesta «sigue esperando», y el workflow se queda quieto para siempre con
     * todos sus pasos escritos y ninguno hecho.
     */
    const current = steps.find((step) => !['completed', 'failed', 'cancelled'].includes(step.status)
      && !(step.kind === 'estimate' && step.status === 'draft'));

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
      /*
       * Lo que se firmó tiene que ser lo que hay. Se comprueba aquí, antes de ejecutar.
       *
       * Un plan consume su aprobación en otro momento y a veces en otro proceso que el que la
       * creó, así que entre la firma y el efecto hay una fila en una base que alguien puede tocar.
       * La huella existía para esto y no se miraba.
       */
      if (approval.status === 'approved'
        && !digestMatches(approval.actionDigest, approval.actionType, approval.target)) {
        db.prepare("UPDATE approvals SET status = 'rejected', resolved_by = 'system' WHERE id = ?")
          .run(approval.id);
        this.#deps.audit.record({
          actorUser: plan.createdBy, eventType: 'approval.tampered', workspaceId: plan.workspaceId,
          payload: { planId: plan.id, approvalId: approval.id, actionType: approval.actionType },
        });
        this.#completeStep(step.id, 'failed', { error: 'approval tampered' });
        this.#finish(plan.id, 'failed',
          'lo que se autorizó no es lo que había guardado: no se ejecutó nada');
        return false;
      }
      if (approval.status !== 'approved') {
        this.#completeStep(step.id, 'cancelled', { status: approval.status });
        this.#finish(plan.id, 'cancelled', 'la persona no autorizó la acción');
        return false;
      }
      /*
       * Una escalada aprobada no ejecuta nada: sólo dice con qué cerebro se piensa el paso
       * siguiente. Va antes que el camino del run porque comparte tabla y estado con él, y
       * confundirlos lanzaría un trabajo que nadie pidió a cambio de una consulta a la nube.
       */
      if (approval.actionType === 'escalate') {
        const consumedEscalation = db.prepare(
          "UPDATE approvals SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'approved'",
        ).run(clock.nowIso(), approval.id);
        if (consumedEscalation.changes === 0) {
          this.#completeStep(step.id, 'failed', { error: 'approval already consumed' });
          this.#finish(plan.id, 'failed', 'esa aprobación ya se había usado');
          return false;
        }
        // El permiso vale para el paso inmediatamente siguiente y para ninguno más.
        db.prepare('UPDATE plans SET escalate_for_step = ? WHERE id = ?').run(step.ordinal + 1, plan.id);
        this.#completeStep(step.id, 'completed', { summary: 'se autorizó consultar al modelo de la nube' });
        return true;
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
    const row = db.prepare('SELECT autonomy FROM plans WHERE id = ?').get(planId) as { autonomy: string };
    /*
     * Un plan de la casa no tiene sesión, y eso ya no es un fallo.
     *
     * Desde la v18 `plans.workspace_id` admite nulo, así que hay planes que no trabajan sobre
     * ninguna sesión de agente. Lo que no pueden es lanzar trabajo —un run necesita un workspace
     * donde vivir— y eso se dice cuando el modelo lo pide, no aquí.
     */
    const workspace = plan.workspaceId ? this.#deps.workspaces.require(plan.workspaceId) : null;
    const steps = this.steps(planId);
    const context = this.#contextFor(plan, workspace, steps);

    // Las herramientas se construyen por turno y atadas a este plan: ninguna alcanza el trabajo de
    // otro workspace ni actúa como otra persona.
    const toolbox = new CoreAssistantToolbox({
      plan, sessions, health, runs, audit, user,
      ...(workspace ? { workspace } : {}),
      /*
       * La autonomía del plan, leída de su fila.
       *
       * Antes no se pasaba y el toolbox caía en su valor por defecto, así que **dentro de un plan
       * no se pedía tarjeta nunca**. Ahora el tipo no admite la omisión, que es lo que convierte
       * esa clase de olvido en un error de compilación en vez de en un permiso concedido.
       */
      autonomy: autonomyOf(row.autonomy),
      ...(this.#deps.mcp ? { mcp: this.#deps.mcp } : {}),
      // En un plan el MCP es de sólo lectura, y la escalada sólo se ofrece si hay nube.
      capabilityWrites: false,
      canEscalate: this.#deps.canEscalate === true,
      ...(this.#deps.starterCapabilities ? { starterCapabilities: this.#deps.starterCapabilities } : {}),
      // Lo que este plan ha lanzado, que es lo único que puede parar por su cuenta.
      ownRunIds: steps.map((step) => step.runId).filter((id): id is string => Boolean(id)),
      ...(this.#deps.attachments ? { attachments: this.#deps.attachments } : {}),
      ...(this.#deps.evidence ? { evidence: this.#deps.evidence } : {}),
      maxObservations: this.#maxToolCalls,
      ...(toolLimits ? { limits: toolLimits } : {}),
    });

    this.#setPlanStatus(planId, 'running');
    let decision: AssistantDecision;
    try {
      decision = await model.decide(context, toolbox);
    } catch (error) {
      return this.#finish(planId, 'failed', `el modelo falló: ${(error as Error).message}`);
    }

    /*
     * Un plan de la casa no lanza trabajo, y se dice al pedirlo.
     *
     * Un run vive en un workspace: sin sesión no hay dónde ponerlo. Se corta aquí —cuando el
     * modelo lo pide— y no al crear el plan, porque un workflow de la casa es perfectamente
     * legítimo mientras se limite a mirar; lo que no puede es acabar lanzando un trabajo.
     */
    const sinSesion = 'este plan no está atado a ninguna sesión, así que no puede lanzar trabajo: '
      + 'lo que necesite una máquina concreta hay que pedirlo desde un workspace';
    if (decision.kind === 'run' && !workspace) return this.#finish(planId, 'failed', sinSesion);

    /*
     * Lo que se sale del sobre no falla ni obedece: se convierte en una tarjeta.
     *
     * Se transforma la decisión **antes** de que llegue a su rama, así que pasa por la misma
     * maquinaria de aprobación que todo lo demás —su digest, su caducidad, su auditoría— en vez de
     * por una copia parecida. Y el motivo viaja al `summary`, que es lo que va a leer la persona:
     * quien mira la tarjeta tiene que entender qué pidió el asistente y qué autorizó él, y «fuera
     * del sobre» no es un motivo.
     *
     * Sin sobre no se comprueba nada. Los planes de antes no lo tienen, y aplicarles esto o
     * pasaría todo —y entonces no comprueba— o bloquearía todo.
     */
    if (decision.kind === 'run' && plan.envelope) {
      const fuera = outsideEnvelope(
        plan.envelope,
        { kind: 'run', host: workspace?.ref.host ?? null, permissionProfile: decision.permissionProfile },
        /*
         * Lo gastado son los pasos **hechos**, no los escritos.
         *
         * En un workflow los pasos existen desde antes de empezar: son estimativos en borrador
         * esperando a que se les ate una decisión. Contarlos como gastados hacía que un plan de
         * seis pasos firmado con `maxSteps: 6` —que es exactamente lo que escribe el modelo, el
         * tope sale igual al número de pasos— se saliera del sobre **en el primer paso**, y
         * entonces la firma no autoriza nada: cada paso vuelve a pedir tarjeta.
         *
         * No se veía porque las pruebas usaban un sobre holgado (`maxSteps: 6` para dos pasos), y
         * un sobre holgado no cruza el borde nunca.
         */
        {
          steps: steps.filter((step) => !(step.kind === 'estimate' && step.status === 'draft')).length,
          runs: steps.filter((step) => step.runId).length,
        },
      );
      if (fuera) {
        const { title, prompt, permissionProfile, rationale } = decision;
        decision = {
          kind: 'approval',
          title,
          actionType: 'run',
          summary: `${rationale || title}. Se sale de lo aprobado: ${fuera}`,
          permissionProfile,
          prompt,
        };
        audit.record({
          actorUser: plan.createdBy,
          eventType: 'workflow.outside_envelope',
          workspaceId: plan.workspaceId,
          payload: { planId, reason: fuera.slice(0, 300) },
        });
      }
    }

    /*
     * A qué paso pertenece lo que el modelo acaba de decidir.
     *
     * En un plan normal cada decisión añade un paso al final, porque el plan se va escribiendo
     * según se piensa. En un workflow los pasos **ya están escritos** —son estimativos— y lo que
     * hace el turno es **atar** el que toca: la decisión ocupa su sitio en vez de añadirse detrás.
     * Sin esto, un workflow de dos pasos acabaría con dos estimativos sin tocar y dos pasos reales
     * al final, y el plan que se firmó no sería el que se ejecutó.
     *
     * Lo que el paso estimativo declaraba —la intención, lo que esperaba, lo que no sabía— se
     * conserva dentro del paso atado: es lo que permite leer después si aquello se cumplió.
     */
    const atar = steps.find((step) => step.kind === 'estimate' && step.status === 'draft');
    const ordinal = atar ? atar.ordinal : steps.length;
    const at = clock.nowIso();
    const stepId = newStepId();
    if (atar) db.prepare('DELETE FROM plan_steps WHERE id = ?').run(atar.id);
    // La clave se deriva del plan y del ordinal: repetir este paso tras un reinicio no puede
    // producir un segundo run.
    const idempotencyKey = `plan:${planId}:${ordinal}`;
    // Lo que el modelo dejó ofrecido viaja con el paso. Ofrecer no es hacer: la terminal la abre
    // la persona desde la interfaz, y si no la abre no ha pasado nada.
    const offer = toolbox.terminalOffer;
    const withOffer = (payload: Record<string, unknown>): Record<string, unknown> => {
      const conOferta = offer ? { ...payload, terminalOffer: offer } : payload;
      return atar ? { ...conOferta, estimate: atar.input } : conOferta;
    };

    if (decision.kind === 'finish') {
      // La síntesis enlaza a la evidencia por id; el contenido sigue donde estaba (M4-11).
      const evidence = this.#evidenceFor(steps, decision.evidenceRunIds);
      db.prepare(`INSERT INTO plan_steps
        (id, plan_id, ordinal, kind, status, title, input_json, output_json, idempotency_key, attempt, finished_at)
        VALUES (?, ?, ?, 'synthesis', 'completed', ?, ?, ?, ?, 1, ?)`)
        .run(stepId, planId, ordinal, 'Síntesis', JSON.stringify({}),
          JSON.stringify(withOffer({ summary: decision.summary, evidence })), idempotencyKey, at);
      /*
       * Cerrar un plan a medias no destruye lo hecho: lo deja **pausado**.
       *
       * Esto no depende de con qué frecuencia el modelo cierre antes de tiempo —el aviso del turno
       * reduce esas veces pero no las quita, medido: una de dos—. Es que cuando pasa, el plan se
       * marcaba `completed` y los pasos firmados que quedaban se perdían sin recurso: para seguir
       * había que proponer el plan entero otra vez y repetir lo ya hecho.
       *
       * `paused` conserva la síntesis y los pasos, y se reanuda con `steer`. Y no se aplica al
       * cierre legítimo: si lo que queda es sólo el paso que esta misma síntesis ata, el plan
       * termina completo, que es como acaba bien un workflow.
       */
      const sinAtar = steps.filter((step) => step.kind === 'estimate' && step.status === 'draft'
        && step.id !== atar?.id).length;
      if (sinAtar > 0) {
        return this.#finish(planId, 'paused',
          `${decision.summary}\n\n(El plan se cerró con ${sinAtar} paso(s) firmados sin dar, así que`
          + ' queda pausado en vez de terminado: lo hecho se conserva y se puede reanudar.)');
      }
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
      // La comprobación va aquí y no arriba porque así es el propio flujo el que garantiza que hay
      // sesión, en vez de un `!` que dice «confía en mí» sobre una guarda que está treinta líneas
      // más arriba y que alguien puede mover.
      if (!workspace) return this.#finish(planId, 'failed', sinSesion);
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
      const digest = approvalDigest(decision.actionType, target);
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

    if (decision.kind === 'escalate') {
      const approvalId = newApprovalId();
      const target = { model: 'cloud', reason: decision.reason, planId };
      const digest = approvalDigest('escalate', target);
      db.prepare(`INSERT INTO approvals
        (id, plan_id, action_type, target_json, action_digest, summary, requested_by, requested_at, expires_at, status)
        VALUES (?, ?, 'escalate', ?, ?, ?, ?, ?, ?, 'pending')`)
        .run(approvalId, planId, JSON.stringify(target), digest,
          `Consultar al modelo de la nube: ${decision.reason}`,
          plan.createdBy, at, new Date(clock.nowMs() + this.#approvalTtlMs).toISOString());
      db.prepare(`INSERT INTO plan_steps
        (id, plan_id, ordinal, kind, status, title, input_json, approval_id, idempotency_key, attempt)
        VALUES (?, ?, ?, 'approval', 'waiting_approval', ?, ?, ?, ?, 1)`)
        .run(stepId, planId, ordinal, 'Salir a la nube',
          JSON.stringify(withOffer({ reason: decision.reason })), approvalId, idempotencyKey);
      this.#setPlanStatus(planId, 'waiting_approval');
      audit.record({
        actorUser: plan.createdBy, eventType: 'assistant.escalation_requested', workspaceId: plan.workspaceId,
        payload: { planId, approvalId, reason: decision.reason.slice(0, 300) },
      });
      return this.require(planId);
    }

    if (decision.kind === 'workflow') {
      /*
       * Un plan no propone workflows: los propone una conversación, que es donde hay alguien a
       * quien enseñárselo antes de firmarlo. Si llega aquí, se dice por qué en vez de caer por el
       * camino del run, que ejecutaría algo que nadie aprobó.
       */
      return this.#finish(planId, 'failed',
        'el modelo propuso un plan de trabajo dentro de un plan que ya está en marcha');
    }

    if (decision.kind === 'revision' || decision.kind === 'steer') {
      /*
       * Corregir o gobernar un workflow tampoco se hace desde dentro.
       *
       * Un plan que se corrigiera a sí mismo mientras corre no tendría a quién enseñarle el cambio,
       * y gobernarse a sí mismo —pausarse, cancelarse— es pedirle que decida sobre lo que está
       * haciendo. Las dos cosas se piden desde la conversación, que es donde hay alguien mirando.
       */
      return this.#finish(planId, 'failed',
        'el modelo quiso cambiar o gobernar un plan desde dentro, y eso se hace desde la conversación');
    }

    if (decision.kind === 'capability') {
      // No se ofrece en un plan y por tanto no debería llegar; si llega, se dice por qué en vez de
      // caer por el camino del run, que ejecutaría algo que nadie pidió.
      return this.#finish(planId, 'failed',
        'el modelo pidió ejecutar una capacidad del sistema, y eso sólo se hace desde una conversación');
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
  #contextFor(plan: Plan, workspace: Workspace | null, steps: PlanStep[]): PlanContext {
    /*
     * Con qué cerebro se piensa este paso.
     *
     * Se lee de la base y no de un campo en memoria porque la autorización puede haberse dado en
     * otro proceso —o antes de un reinicio— y porque vale exactamente para un ordinal: el paso
     * siguiente vuelve a casa sin que nadie tenga que apagar nada.
     */
    const escalation = this.#deps.db.prepare('SELECT escalate_for_step FROM plans WHERE id = ?')
      .get(plan.id) as { escalate_for_step: number | null } | undefined;
    const source: 'local' | 'cloud' = escalation?.escalate_for_step === steps.length ? 'cloud' : 'local';
    const history: PlanHistoryEntry[] = steps.map((step) => ({
      ordinal: step.ordinal,
      kind: step.kind,
      title: step.title,
      status: step.status,
      summary: stepSummary(step),
      runId: step.runId,
      errorCode: step.errorCode,
      /*
       * Lo que el paso dejó, y no sólo su resumen.
       *
       * `stepSummary` mira cuatro claves conocidas —`summary`, `answer`, `error`, `status`— y
       * devuelve `null` para todo lo demás. En un plan normal eso bastaba: los pasos producían
       * runs y los runs traen su resumen. En un workflow no: lo que un paso estimativo le tiene
       * que contar al siguiente **es** su salida, y con `stepSummary` se perdía entera.
       *
       * Va recortado y **se dice que se recorta**, como en las herramientas: ocho pasos con la
       * salida completa crecen rápido y lo paga el modelo en cada turno. Lo que haga falta entero
       * es evidencia y se pide con `get_run`.
       */
      ...(plan.envelope ? { output: clipOutput(step.output) } : {}),
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
      /*
       * Sin sesión, el contexto **lo dice** en vez de inventarse un workspace vacío.
       *
       * Un objeto con todos los campos en nulo se lee como «hay una sesión y no sé nada de ella»,
       * que es peor que no tenerla: el modelo se pone a hablar de una sesión que no existe.
       */
      ...(workspace ? {
        workspace: {
          id: workspace.id,
          host: workspace.ref.host,
          provider: workspace.ref.provider,
          sessionId: workspace.ref.sessionId,
          cwd: workspace.cwd,
          title: workspace.title,
        },
      } : {}),
      history,
      pendingInput,
      pendingApprovals,
      source,
      /*
       * El perímetro y el plan escrito, sólo si esto es un workflow.
       *
       * Un plan sin sobre no gana nada con esto y sí cambia lo que ve su modelo, así que se deja
       * exactamente como estaba: lo que decide es tener sobre, no ser un plan.
       */
      ...(plan.envelope ? { envelope: plan.envelope, plannedSteps: plannedFrom(steps) } : {}),
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
