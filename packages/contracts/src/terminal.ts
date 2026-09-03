import { Type, type Static } from '@sinclair/typebox';
import { HostName, Iso8601, PermissionProfile, Provider } from './common.js';

export const TerminalSession = Type.Object({
  name: Type.String({ pattern: '^jarvis-[A-Za-z0-9_.-]+$' }),
  host: HostName,
  createdAt: Type.Union([Iso8601, Type.Null()]),
  attached: Type.Boolean(),
  windows: Type.Integer(),
  /** Un run tiene su propia tmux; distinguirlas evita matar trabajo por error. */
  kind: Type.Union([Type.Literal('run'), Type.Literal('interactive')]),
});
export type TerminalSession = Static<typeof TerminalSession>;

export const OpenTerminalRequest = Type.Object({
  host: HostName,
  provider: Provider,
  sessionId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  cwd: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  permissionProfile: Type.Optional(PermissionProfile),
  /**
   * Desde qué workspace se abre.
   *
   * Con esto el servidor resuelve el directorio y la sesión por su cuenta, en vez de fiarse de lo
   * que le llegue en la petición: quien conoce el `cwd` de una sesión es el core, que lo tiene
   * guardado y hasta sabe deducirlo. Sigue admitiéndose un `cwd` explícito —una terminal suelta en
   * otra carpeta es un caso legítimo— pero cuando viene el workspace, manda lo que el core sabe.
   */
  workspaceId: Type.Optional(Type.String()),
});
export type OpenTerminalRequest = Static<typeof OpenTerminalRequest>;

/** Mensajes de control del canal WebSocket. Los bytes del TTY viajan como frames binarios. */
export const TerminalControl = Type.Union([
  Type.Object({ type: Type.Literal('resize'), cols: Type.Integer(), rows: Type.Integer() }),
  Type.Object({ type: Type.Literal('ping') }),
]);
export type TerminalControl = Static<typeof TerminalControl>;
