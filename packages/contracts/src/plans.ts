import { Type, type Static } from '@sinclair/typebox';
import { Iso8601 } from './common.js';

export const PLAN_STATUSES = [
  'ready', 'running', 'waiting_run', 'waiting_approval', 'waiting_input',
  'completed', 'failed', 'cancelled',
] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export const PlanStatusSchema = Type.Union(PLAN_STATUSES.map((s) => Type.Literal(s)));

export const PLAN_STEP_KINDS = ['run', 'approval', 'input', 'synthesis'] as const;
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
