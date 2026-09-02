import { Type, type Static } from '@sinclair/typebox';
import { HostName, Iso8601, Provider } from './common.js';

export const UsageLimit = Type.Object({
  label: Type.String(),
  usedPercent: Type.Number({ minimum: 0, maximum: 100 }),
  remainingPercent: Type.Number({ minimum: 0, maximum: 100 }),
  windowMinutes: Type.Union([Type.Integer(), Type.Null()]),
  resetsAt: Type.Union([Iso8601, Type.Null()]),
  resetDescription: Type.Union([Type.String(), Type.Null()]),
});
export type UsageLimit = Static<typeof UsageLimit>;

export const UsageAccount = Type.Object({
  email: Type.Union([Type.String(), Type.Null()]),
  plan: Type.Union([Type.String(), Type.Null()]),
  authMethod: Type.Union([Type.String(), Type.Null()]),
});

export const UsageSnapshot = Type.Object({
  provider: Provider,
  executionHost: HostName,
  account: Type.Union([UsageAccount, Type.Null()]),
  limits: Type.Array(UsageLimit),
  fetchedAt: Iso8601,
  /** El dato es el último bueno conocido y la última sonda falló. */
  stale: Type.Boolean(),
  refreshError: Type.Union([Type.String(), Type.Null()]),
});
export type UsageSnapshot = Static<typeof UsageSnapshot>;
