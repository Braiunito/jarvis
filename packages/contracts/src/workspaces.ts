import { Type, type Static } from '@sinclair/typebox';
import { Iso8601 } from './common.js';
import { SessionRef } from './sessions.js';

export const Provenance = Type.Union([
  Type.Literal('jarvis'),
  Type.Literal('litechat-import'),
]);

export const Workspace = Type.Object({
  id: Type.String(),
  ref: SessionRef,
  cwd: Type.Union([Type.String(), Type.Null()]),
  sourceRoot: Type.Union([Type.String(), Type.Null()]),
  title: Type.Union([Type.String(), Type.Null()]),
  createdBy: Type.String(),
  createdAt: Iso8601,
  updatedAt: Iso8601,
  lastOpenedAt: Type.Union([Iso8601, Type.Null()]),
  provenance: Provenance,
  /**
   * La sesión se estrenó desde Jarvis y su identificador todavía no lo ha confirmado el agente.
   *
   * Sólo lo llevan las sesiones nuevas de Codex y OpenCode, que generan el suyo y lo dicen en su
   * primer evento; mientras tanto el id que se ve va a cambiar, y la interfaz no debería
   * ofrecerlo para copiar ni tratarlo como estable.
   */
  sessionPending: Type.Optional(Type.Boolean()),
  /**
   * La conversación ya existe en la máquina.
   *
   * `false` en una sesión recién estrenada desde Jarvis a la que todavía no se le ha mandado nada:
   * el workspace existe, pero al otro lado no hay nada que reanudar hasta el primer trabajo.
   */
  sessionLaunched: Type.Optional(Type.Boolean()),
});
export type Workspace = Static<typeof Workspace>;

export const OpenWorkspaceRequest = Type.Object({
  ref: SessionRef,
  cwd: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  sourceRoot: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  title: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
export type OpenWorkspaceRequest = Static<typeof OpenWorkspaceRequest>;

/** Borrador con compare-and-swap: dos pestañas no se pisan en silencio. */
export const Draft = Type.Object({
  workspaceId: Type.String(),
  body: Type.String(),
  version: Type.Integer({ minimum: 0 }),
  updatedAt: Iso8601,
});
export type Draft = Static<typeof Draft>;

export const PutDraftRequest = Type.Object({
  body: Type.String({ maxLength: 200_000 }),
  expectedVersion: Type.Integer({ minimum: 0 }),
});
export type PutDraftRequest = Static<typeof PutDraftRequest>;
