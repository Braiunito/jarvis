import { Type, type Static } from '@sinclair/typebox';

/** Alias SSH tal y como aparece en la configuración; nunca una IP escrita por el usuario. */
export const HostName = Type.String({ pattern: '^[A-Za-z0-9._@][A-Za-z0-9._@-]*$', maxLength: 128 });

export const Provider = Type.Union([
  Type.Literal('claude'),
  Type.Literal('codex'),
  Type.Literal('opencode'),
]);
export type Provider = Static<typeof Provider>;
export const PROVIDERS: Provider[] = ['claude', 'codex', 'opencode'];

/**
 * Cuánta libertad tiene un run. Nunca se eleva de forma implícita: quien lanza el trabajo lo
 * declara y el snapshot del run conserva lo declarado.
 */
export const PermissionProfile = Type.Union([
  Type.Literal('safe'),
  Type.Literal('auto'),
  Type.Literal('yolo'),
]);
export type PermissionProfile = Static<typeof PermissionProfile>;
export const PERMISSION_PROFILES: PermissionProfile[] = ['safe', 'auto', 'yolo'];

/** Dónde corre el agente respecto de dónde está el trabajo (ver ADR-005). */
export const Strategy = Type.Union([
  Type.Literal('bastion'),
  Type.Literal('A'),
  Type.Literal('B'),
]);
export type Strategy = Static<typeof Strategy>;

export const Iso8601 = Type.String({ format: 'date-time', minLength: 20, maxLength: 32 });
export const OpaqueId = Type.String({ pattern: '^[A-Za-z0-9_-]{1,64}$' });

export const Pagination = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
});
export type Pagination = Static<typeof Pagination>;

export const PageMeta = Type.Object({
  nextCursor: Type.Union([Type.String(), Type.Null()]),
  /** Los datos pueden ser viejos y seguir siendo útiles; la UI los fecha en lugar de vaciarse. */
  stale: Type.Optional(Type.Boolean()),
  fetchedAt: Type.Optional(Iso8601),
});
