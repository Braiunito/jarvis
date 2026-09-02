import { Type, type Static } from '@sinclair/typebox';
import { HostName, Iso8601, Provider, Strategy } from './common.js';

export const ATTACHMENT_STATES = ['staged', 'claimed', 'released', 'expired', 'failed', 'release_pending'] as const;
export type AttachmentState = (typeof ATTACHMENT_STATES)[number];

export const Attachment = Type.Object({
  id: Type.String(),
  ownerUser: Type.String(),
  workspaceId: Type.Union([Type.String(), Type.Null()]),
  scopeId: Type.String(),
  provider: Provider,
  executionHost: HostName,
  strategy: Strategy,
  displayName: Type.String(),
  mimeType: Type.String(),
  sizeBytes: Type.Integer({ minimum: 0 }),
  /** Path generado por Jarvis. Nunca deriva del nombre que envió el usuario. */
  remotePath: Type.String(),
  state: Type.Union(ATTACHMENT_STATES.map((s) => Type.Literal(s))),
  createdAt: Iso8601,
  expiresAt: Iso8601,
  claimedRunId: Type.Union([Type.String(), Type.Null()]),
  releasedAt: Type.Union([Iso8601, Type.Null()]),
});
export type Attachment = Static<typeof Attachment>;
