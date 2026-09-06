import { Type, type Static } from '@sinclair/typebox';
import { AutonomyModeSchema } from './chat.js';
import { HostName, Iso8601, PermissionProfile } from './common.js';

export const PLAN_STATUSES = [
  /**
   * Propuesto y sin aprobar. Es el estado en el que nace un workflow.
   *
   * Existe porque el asistente ahora propone el plan **entero** antes de tocar nada, y entre que lo
   * propone y alguien lo firma hay un plan de verdad —con sus pasos escritos y su sobre— que no
   * debe avanzar. `ready` significa «le toca pensar»; un borrador no le toca.
   */
  'draft',
  'ready', 'running', 'waiting_run', 'waiting_approval', 'waiting_input',
  'completed', 'failed', 'cancelled',
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export const PlanStatusSchema = Type.Union(PLAN_STATUSES.map((s) => Type.Literal(s)));

/**
 * `estimate` es un paso **sin herramienta asignada**, y ésa es su razón de ser.
 *
 * Cuando el asistente propone un plan no sabe todavía con qué lo va a hacer: sabe qué quiere
 * conseguir en cada paso y qué espera que quede. Obligarle a nombrar la herramienta en el borrador
 * es pedirle que invente, y lo hace. Al llegar a un paso `estimate`, el turno lo **ata** a una
 * acción concreta llamando a `create_run` o a `request_capability`, que ya existen.
 */
export const PLAN_STEP_KINDS = ['run', 'approval', 'input', 'synthesis', 'estimate'] as const;
export type PlanStepKind = (typeof PLAN_STEP_KINDS)[number];

export const PlanStep = Type.Object({
  id: Type.String(),
  planId: Type.String(),
  ordinal: Type.Integer({ minimum: 0 }),
  kind: Type.Union(PLAN_STEP_KINDS.map((k) => Type.Literal(k))),
  status: PlanStatusSchema,
  title: Type.String(),
  input: Type.Unknown(),
  output: Type.Unknown(),
  runId: Type.Union([Type.String(), Type.Null()]),
  approvalId: Type.Union([Type.String(), Type.Null()]),
  idempotencyKey: Type.String(),
  attempt: Type.Integer({ minimum: 1 }),
  availableAt: Type.Union([Iso8601, Type.Null()]),
  startedAt: Type.Union([Iso8601, Type.Null()]),
  finishedAt: Type.Union([Iso8601, Type.Null()]),
  errorCode: Type.Union([Type.String(), Type.Null()]),
});
export type PlanStep = Static<typeof PlanStep>;

/**
 * Lo que una persona firma cuando aprueba un workflow.
 *
 * **No es la lista de pasos**, y eso es el diseño entero. Un plan estimativo va a cambiar por
 * definición —para eso se corrige sobre la marcha— así que firmar los pasos sería invalidar la
 * aprobación en la primera corrección, y la salida sería pedir tarjeta por cada paso, que es
 * exactamente lo que un workflow existe para evitar.
 *
 * Lo que sí se puede firmar es el **perímetro**: dónde puede tocar, cuánto puede gastar, con qué
 * permiso y qué capacidades puede usar. Dentro de él se ejecuta sin preguntar, porque para eso se
 * firmó; fuera, el core no falla ni obedece: convierte la decisión en una tarjeta que dice qué se
 * sale de lo aprobado.
 */
export const WorkflowEnvelope = Type.Object({
  /** Las máquinas que puede tocar. Vacío significa ninguna, no todas. */
  hosts: Type.Array(HostName),
  maxSteps: Type.Integer({ minimum: 1 }),
  maxRuns: Type.Integer({ minimum: 0 }),
  /** El permiso más alto con el que puede lanzar trabajo. Nunca `yolo`: eso no se firma aquí. */
  highestPermissionProfile: PermissionProfile,
  /** Si puede modificar algo en alguna máquina. Falso es un workflow de sólo mirar. */
  writes: Type.Boolean(),
  /**
   * Las capacidades MCP que puede usar, **por su nombre**.
   *
   * Por nombre y no por área, y está medido: las áreas del catálogo mezclan lectura y destrucción
   * —`journal_query` vive en «servicios» junto a `stop_service`— y además sus miembros crecen
   * después de firmar, así que firmar un área es firmar lo que aparezca mañana. El área se puede
   * enseñar en la tarjeta para que se lea corto; lo que el digest cubre son los nombres.
   */
  capabilities: Type.Array(Type.String()),
});
export type WorkflowEnvelope = Static<typeof WorkflowEnvelope>;

/** Lo que lleva dentro un paso estimativo, antes de saber con qué se hará. */
export const EstimateStepInput = Type.Object({
  /** Qué se quiere conseguir aquí. */
  intent: Type.String(),
  /** Qué habrá cuando termine, para poder decir si salió. */
  expects: Type.String(),
  /**
   * Lo que aún no se sabe.
   *
   * Es lo más valioso del borrador: quien lo aprueba tiene que ver qué queda por decidir. Un plan
   * que no declara ninguna incógnita o es trivial o está fingiendo.
   */
  unknowns: Type.Array(Type.String()),
  /** Si este paso modificaría algo en una máquina. */
  writes: Type.Boolean(),
  /** A qué quedó atado al llegar aquí: el run o la capacidad que lo cumplió. */
  boundTo: Type.Optional(Type.String()),
});
export type EstimateStepInput = Static<typeof EstimateStepInput>;

export const Plan = Type.Object({
  id: Type.String(),
  workspaceId: Type.String(),
  createdBy: Type.String(),
  objective: Type.String(),
  status: PlanStatusSchema,
  currentStep: Type.Integer({ minimum: 0 }),
  createdAt: Iso8601,
  updatedAt: Iso8601,
  finishedAt: Type.Union([Iso8601, Type.Null()]),
  summary: Type.Union([Type.String(), Type.Null()]),
  /** Cuánta cuerda tiene en este plan. Sin default: un plan declara su postura (ADR-010). */
  autonomy: AutonomyModeSchema,
  /**
   * De qué conversación salió, si salió de una.
   *
   * Es lo que cierra el bucle de un workflow: el borrador se enseña en el hilo, la tarjeta vuelve
   * al hilo, y el avance se cuenta ahí. Sin esto, el asistente propone un plan y luego no tiene
   * dónde contar qué pasó con él.
   */
  conversationId: Type.Union([Type.String(), Type.Null()]),
  /** El perímetro firmado, si es un workflow. Los planes de antes no lo tienen. */
  envelope: Type.Union([WorkflowEnvelope, Type.Null()]),
});
export type Plan = Static<typeof Plan>;

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired', 'consumed'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/**
 * Una aprobación es un objeto de dominio, no un modal booleano: registra qué acción, sobre qué
 * target, con qué permiso y hasta cuándo. Cambiar cualquiera de esas cosas cambia el digest y
 * la invalida.
 */
export const Approval = Type.Object({
  id: Type.String(),
  planId: Type.Union([Type.String(), Type.Null()]),
  /**
   * De qué conversación salió, si salió de una (ADR-009).
   *
   * Es exclusivo con `planId` en la práctica: una aprobación pertenece al hilo que la pidió. Se
   * guarda porque quien la resuelve tiene que poder volver a donde estaba, y porque el motor que
   * la ejecuta al aprobarla no es el mismo en los dos casos.
   */
  conversationId: Type.Union([Type.String(), Type.Null()]),
  runId: Type.Union([Type.String(), Type.Null()]),
  actionType: Type.String(),
  target: Type.Unknown(),
  actionDigest: Type.String(),
  summary: Type.String(),
  requestedBy: Type.String(),
  requestedAt: Iso8601,
  expiresAt: Iso8601,
  status: Type.Union(APPROVAL_STATUSES.map((s) => Type.Literal(s))),
  resolvedBy: Type.Union([Type.String(), Type.Null()]),
  resolvedAt: Type.Union([Iso8601, Type.Null()]),
  consumedAt: Type.Union([Iso8601, Type.Null()]),
});
export type Approval = Static<typeof Approval>;
