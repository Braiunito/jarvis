import { Type, type Static } from '@sinclair/typebox';

/** Quién actúa, tal y como el gateway se lo cuenta al core (ADR-001). */
export const UserIdentity = Type.Object({
  userId: Type.String(),
  username: Type.String(),
});
export type UserIdentity = Static<typeof UserIdentity>;

export const PublicCredential = Type.Object({
  id: Type.String(),
  name: Type.String(),
  createdAt: Type.String(),
  lastUsedAt: Type.Union([Type.String(), Type.Null()]),
  transports: Type.Optional(Type.Array(Type.String())),
  backedUp: Type.Optional(Type.Boolean()),
});

export const PublicUser = Type.Object({
  username: Type.String(),
  displayName: Type.String(),
  credentials: Type.Array(PublicCredential),
  totp: Type.Union([
    Type.Object({ confirmed: Type.Boolean(), recoveryCodesLeft: Type.Integer() }),
    Type.Null(),
  ]),
});
export type PublicUser = Static<typeof PublicUser>;

export const AuthConfig = Type.Object({
  rpId: Type.String(),
  rpName: Type.String(),
  steps: Type.Array(Type.String()),
  discoverableLogin: Type.Boolean(),
  userVerification: Type.Union([Type.Literal('required'), Type.Literal('preferred')]),
  insecureLogin: Type.Boolean(),
});
export type AuthConfig = Static<typeof AuthConfig>;
