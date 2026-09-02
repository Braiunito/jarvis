import { Type, type Static } from '@sinclair/typebox';
import { Iso8601 } from './common.js';

export const CHECK_STATUSES = ['ok', 'stale', 'degraded', 'failed', 'unknown'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const HealthCheck = Type.Object({
  status: Type.Union(CHECK_STATUSES.map((s) => Type.Literal(s))),
  code: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  lastOkAt: Type.Optional(Type.Union([Iso8601, Type.Null()])),
  lastAt: Type.Optional(Type.Union([Iso8601, Type.Null()])),
  detail: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type HealthCheck = Static<typeof HealthCheck>;

/**
 * La salud se reporta por salto. Que goro2 no responda no deja la aplicación «offline»: deja
 * un check en `failed` y todo lo demás usable.
 */
export const Health = Type.Object({
  status: Type.Union([Type.Literal('ok'), Type.Literal('degraded'), Type.Literal('failed')]),
  service: Type.String(),
  version: Type.String(),
  at: Iso8601,
  checks: Type.Record(Type.String(), HealthCheck),
  /** Lo que la barra de estado enseña sin tener que preguntar a nadie más. */
  system: Type.Optional(Type.Object({
    startedAt: Iso8601,
    uptimeSeconds: Type.Integer(),
    node: Type.String(),
    sqlite: Type.String(),
    hosts: Type.Integer(),
    bastionHost: Type.String(),
  })),
});
export type Health = Static<typeof Health>;
