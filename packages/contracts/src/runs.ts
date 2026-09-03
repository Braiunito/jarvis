import { Type, type Static } from '@sinclair/typebox';
import { HostName, Iso8601, PermissionProfile, Provider, Strategy } from './common.js';
import { TargetPlan } from './target.js';

/**
 * Estados de un run. `interrupted` del stack viejo se normaliza a `cancelled`; el motivo viaja
 * en el evento, no en el nombre del estado.
 */
export const RUN_STATUSES = [
  'queued',
  'preparing',
  'running',
  'waiting',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const RunStatusSchema = Type.Union(RUN_STATUSES.map((s) => Type.Literal(s)));

export const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled', 'timed_out'] as const;
export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];
export const isTerminalStatus = (status: RunStatus): status is TerminalRunStatus =>
  (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);

/**
 * Transiciones permitidas. Una transición fuera de esta tabla es un fallo de programación y se
 * trata como tal: se lanza `INVALID_TRANSITION`, no se «arregla» silenciosamente.
 */
export const RUN_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = Object.freeze({
  queued: ['preparing', 'cancelling', 'cancelled', 'failed'],
  preparing: ['running', 'cancelling', 'failed', 'completed', 'cancelled', 'timed_out'],
  running: ['waiting', 'cancelling', 'completed', 'failed', 'timed_out'],
  waiting: ['running', 'cancelling', 'completed', 'failed', 'timed_out'],
  cancelling: ['cancelled', 'completed', 'failed', 'timed_out'],
  completed: [],
  failed: [],
  cancelled: [],
  timed_out: [],
});

export const canTransition = (from: RunStatus, to: RunStatus): boolean =>
  (RUN_TRANSITIONS[from] as readonly string[]).includes(to);

export const ToolEvent = Type.Object({
  id: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
  input: Type.Optional(Type.Unknown()),
  output: Type.Optional(Type.String()),
  status: Type.Optional(Type.Union([
    Type.Literal('started'), Type.Literal('completed'), Type.Literal('error'),
  ])),
  /** Marcado cuando el payload se recortó; nunca se trunca en silencio. */
  truncated: Type.Optional(Type.Boolean()),
  originalBytes: Type.Optional(Type.Integer()),
});
export type ToolEvent = Static<typeof ToolEvent>;

/** Lo que produce un adapter tras normalizar la salida cruda de un CLI. */
export const AgentEvent = Type.Union([
  Type.Object({
    type: Type.Literal('started'),
    sessionId: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    cwd: Type.Optional(Type.String()),
    permissionMode: Type.Optional(Type.String()),
    tools: Type.Optional(Type.Array(Type.String())),
  }),
  Type.Object({ type: Type.Literal('text'), text: Type.String(), sessionId: Type.Optional(Type.String()) }),
  Type.Object({ type: Type.Literal('reasoning'), text: Type.String(), sessionId: Type.Optional(Type.String()) }),
  Type.Object({ type: Type.Literal('tool'), tool: ToolEvent, sessionId: Type.Optional(Type.String()) }),
  Type.Object({
    type: Type.Literal('result'),
    ok: Type.Boolean(),
    text: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    sessionId: Type.Optional(Type.String()),
    usage: Type.Optional(Type.Unknown()),
    costUsd: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    durationMs: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    turns: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
    stopReason: Type.Optional(Type.String()),
  }),
  Type.Object({ type: Type.Literal('error'), message: Type.String(), payload: Type.Optional(Type.Unknown()) }),
  Type.Object({ type: Type.Literal('raw'), payload: Type.Optional(Type.Unknown()), text: Type.Optional(Type.String()), note: Type.Optional(Type.String()) }),
]);
export type AgentEvent = Static<typeof AgentEvent>;

export const RUN_EVENT_TYPES = [
  'run.status',
  'run.target',
  'run.cancel_requested',
  'runner.stderr',
  'agent.started',
  'agent.text',
  'agent.reasoning',
  'agent.tool',
  'agent.result',
  'agent.error',
  'agent.raw',
] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

/**
 * Un evento confirmado. `seq` es identidad pública y durable: empieza en 0 por run, nunca se
 * reutiliza ni se renumera, ni siquiera al compactar.
 */
export const RunEvent = Type.Object({
  runId: Type.String(),
  seq: Type.Integer({ minimum: 0 }),
  at: Iso8601,
  type: Type.Union(RUN_EVENT_TYPES.map((t) => Type.Literal(t))),
  payload: Type.Unknown(),
  /** El payload pesado fue reemplazado por metadata; la fila y el `seq` siguen ahí. */
  compacted: Type.Optional(Type.Boolean()),
});
export type RunEvent = Static<typeof RunEvent>;

export const Run = Type.Object({
  id: Type.String(),
  workspaceId: Type.String(),
  createdBy: Type.String(),
  provider: Provider,
  sessionId: Type.Union([Type.String(), Type.Null()]),
  workHost: HostName,
  executionHost: HostName,
  strategy: Strategy,
  strategyReason: Type.Union([Type.String(), Type.Null()]),
  cwd: Type.Union([Type.String(), Type.Null()]),
  permissionProfile: PermissionProfile,
  model: Type.Union([Type.String(), Type.Null()]),
  status: RunStatusSchema,
  attempt: Type.Integer({ minimum: 1 }),
  parentRunId: Type.Union([Type.String(), Type.Null()]),
  remoteName: Type.Union([Type.String(), Type.Null()]),
  lastEventSeq: Type.Integer({ minimum: -1 }),
  createdAt: Iso8601,
  startedAt: Type.Union([Iso8601, Type.Null()]),
  finishedAt: Type.Union([Iso8601, Type.Null()]),
  cancelRequestedAt: Type.Union([Iso8601, Type.Null()]),
  exitCode: Type.Union([Type.Integer(), Type.Null()]),
  errorCode: Type.Union([Type.String(), Type.Null()]),
  errorMessage: Type.Union([Type.String(), Type.Null()]),
  resultOk: Type.Union([Type.Boolean(), Type.Null()]),
  resultSummary: Type.Union([Type.String(), Type.Null()]),
  /**
   * Cuándo alguien dio este trabajo por visto.
   *
   * Sólo afecta a si sigue reclamando atención en la navegación: el trabajo, su estado y sus
   * eventos no cambian. Un contador que no se puede vaciar deja de mirarse.
   */
  acknowledgedAt: Type.Optional(Type.Union([Iso8601, Type.Null()])),
  /** Este trabajo estrena la conversación: arranca el agente sin reanudar nada. */
  startsSession: Type.Optional(Type.Boolean()),
  /**
   * Lo que pidió la persona, recortado.
   *
   * Un trabajo se reconoce por lo que se pidió, no por su identificador: `rt40nhvqeujq` no le dice
   * nada a nadie. Va recortado y en una línea porque alimenta listas, no lectura; el prompt entero
   * sigue sin salir del core, que es donde tiene que estar.
   */
  promptPreview: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
});
export type Run = Static<typeof Run>;

export const CreateRunRequest = Type.Object({
  workspaceId: Type.String(),
  prompt: Type.String({ maxLength: 200_000 }),
  permissionProfile: Type.Optional(PermissionProfile),
  preferredStrategy: Type.Optional(Type.Union([Type.Literal('auto'), Type.Literal('A'), Type.Literal('B')])),
  model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  attachmentIds: Type.Optional(Type.Array(Type.String())),
  /*
   * Aquí **no** hay `startsSession`, y su ausencia es la garantía.
   *
   * Si un trabajo estrena la conversación o la continúa lo decide el servidor mirando lo que tiene
   * guardado, y no quien llama. Publicarlo dejaba que un cliente forzara reanudar una sesión que
   * todavía no existe —o estrenar encima de una que sí— y convertía un invariante en una
   * convención: sólo se cumplía mientras todas las interfaces se portaran bien y estuvieran al
   * día. Un invariante que depende de la buena fe del cliente no es un invariante.
   */
  /** Para que un doble toque en el móvil no cree dos runs. */
  idempotencyKey: Type.Optional(Type.String({ maxLength: 128 })),
});
export type CreateRunRequest = Static<typeof CreateRunRequest>;

export const CreateRunResponse = Type.Object({
  run: Run,
  target: TargetPlan,
  /** true cuando la idempotency key ya había creado este run. */
  replayed: Type.Boolean(),
});
export type CreateRunResponse = Static<typeof CreateRunResponse>;
