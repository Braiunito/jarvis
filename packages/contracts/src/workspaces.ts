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
