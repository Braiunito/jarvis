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
  /**
   * El nombre que tiene ese workspace.
   *
   * El índice sólo sabe lo que puso la CLI, y eso es un hash en cuanto la sesión no tuvo un primer
   * mensaje aprovechable. Si aquí ya se le puso nombre —a mano o automáticamente— es el que hay
   * que enseñar: si no, renombrar un workspace no se nota al volver a la lista y parece que no se
   * guardó.
   */
  workspaceTitle: Type.Union([Type.String(), Type.Null()]),
  /**
   * Una sesión en la que nunca llegó a pasar nada.
   *
   * Lo decide el core con los contadores del índice, no con el nombre: que se llame
   * `Claude a758cca7` es una consecuencia —el índice cae a ese nombre cuando ningún mensaje de la
   * persona sirve para titular—, no la causa. Reanudar una de éstas da un agente sin contexto que
   * termina el turno sin decir nada, y eso se lee como un fallo de la aplicación.
   */
  empty: Type.Boolean(),
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
  /**
   * El índice devolvió tantas como se le pidieron, así que hay más y no se están viendo.
   *
   * Se dice en vez de callarlo: una lista recortada en silencio es la peor clase de dato, porque
   * quien la mira concluye que lo que falta no existe.
   */
  truncated: Type.Boolean(),
  fetchedAt: Iso8601,
});
export type SessionSearchResult = Static<typeof SessionSearchResult>;
