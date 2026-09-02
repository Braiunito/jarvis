import { Type, type Static } from '@sinclair/typebox';
import { HostName, Iso8601, Provider } from './common.js';

/**
 * La identidad de una sesión de agente. La posee el CLI remoto, no Jarvis: por eso viaja como
 * referencia y nunca como rowid del índice (ADR-005).
 */
export const SessionRef = Type.Object({
  host: HostName,
  provider: Provider,
  sessionId: Type.String({ minLength: 1, maxLength: 200 }),
});
export type SessionRef = Static<typeof SessionRef>;

export const SessionSummary = Type.Object({
  ref: SessionRef,
  title: Type.Union([Type.String(), Type.Null()]),
  cwd: Type.Union([Type.String(), Type.Null()]),
  sourceRoot: Type.Union([Type.String(), Type.Null()]),
  messageCount: Type.Union([Type.Integer(), Type.Null()]),
  startedAt: Type.Union([Iso8601, Type.Null()]),
  lastActivityAt: Type.Union([Iso8601, Type.Null()]),
  preview: Type.Union([Type.String(), Type.Null()]),
  /** Workspace ya abierto para esta sesión, si existe. */
  workspaceId: Type.Union([Type.String(), Type.Null()]),
});
export type SessionSummary = Static<typeof SessionSummary>;

export const TranscriptMessage = Type.Object({
  role: Type.Union([Type.Literal('user'), Type.Literal('assistant'), Type.Literal('system'), Type.Literal('tool')]),
  at: Type.Union([Iso8601, Type.Null()]),
  text: Type.String(),
  /** De dónde viene lo que se muestra: importado, escrito aquí, salida de tool, evidencia. */
  provenance: Type.Union([
    Type.Literal('remote-transcript'),
    Type.Literal('jarvis-run'),
    Type.Literal('litechat-import'),
    Type.Literal('system'),
  ]),
});
export type TranscriptMessage = Static<typeof TranscriptMessage>;

/** Frescura por host: un índice viejo sigue siendo usable si se dice cuándo se miró. */
export const HostFreshness = Type.Object({
  host: HostName,
  lastSyncAt: Type.Union([Iso8601, Type.Null()]),
  ageSeconds: Type.Union([Type.Integer(), Type.Null()]),
  sessionCount: Type.Integer(),
  status: Type.Union([Type.Literal('ok'), Type.Literal('stale'), Type.Literal('failed'), Type.Literal('unknown')]),
  error: Type.Union([Type.String(), Type.Null()]),
});
export type HostFreshness = Static<typeof HostFreshness>;

export const SessionSearchQuery = Type.Object({
  q: Type.Optional(Type.String({ maxLength: 200 })),
  host: Type.Optional(HostName),
  provider: Type.Optional(Provider),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
});
export type SessionSearchQuery = Static<typeof SessionSearchQuery>;

export const SessionSearchResult = Type.Object({
  sessions: Type.Array(SessionSummary),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
  freshness: Type.Array(HostFreshness),
  stale: Type.Boolean(),
  fetchedAt: Iso8601,
});
export type SessionSearchResult = Static<typeof SessionSearchResult>;
