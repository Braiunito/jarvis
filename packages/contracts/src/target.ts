import { Type, type Static } from '@sinclair/typebox';
import { HostName, Iso8601, PermissionProfile, Provider, Strategy } from './common.js';

export const HostCapabilities = Type.Object({
  host: HostName,
  reachable: Type.Boolean(),
  binaries: Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()])),
  providers: Type.Array(Provider),
  tmux: Type.Boolean(),
  probedAt: Iso8601,
  /** Último resultado bueno conservado cuando la sonda falla. */
  stale: Type.Optional(Type.Boolean()),
  error: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
export type HostCapabilities = Static<typeof HostCapabilities>;

/**
 * El destino efectivo de un trabajo. Se muestra antes de Send y se guarda como snapshot en el
 * run: lo que el usuario vio es lo que la auditoría afirma.
 */
export const TargetPlan = Type.Object({
  workHost: HostName,
  executionHost: HostName,
  strategy: Strategy,
  reason: Type.Union([Type.String(), Type.Null()]),
  cwd: Type.Union([Type.String(), Type.Null()]),
  provider: Provider,
  permissionProfile: PermissionProfile,
});
export type TargetPlan = Static<typeof TargetPlan>;
