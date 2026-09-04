import { Type, type Static } from '@sinclair/typebox';

/**
 * Códigos de error públicos y estables.
 *
 * La UI discrimina por `code`, nunca por `message`: el texto está para una persona y puede
 * cambiar de idioma o de redacción sin que eso rompa un cliente.
 */
export const ERROR_CODES = [
  'BAD_REQUEST',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'DRAFT_VERSION_CONFLICT',
  'VALIDATION_FAILED',
  'RATE_LIMITED',
  'PAYLOAD_TOO_LARGE',
  'QUOTA_EXCEEDED',
  'HOST_NOT_ALLOWED',
  'HOST_UNREACHABLE',
  'PROVIDER_MISSING',
  'STRATEGY_IMPOSSIBLE',
  'TMUX_MISSING',
  'RUNNER_LOST',
  'RUN_NOT_CANCELLABLE',
  'INVALID_TRANSITION',
  'INDEX_UNAVAILABLE',
  'UPSTREAM_UNAVAILABLE',
  'APPROVAL_EXPIRED',
  'APPROVAL_CONSUMED',
  'PERMISSION_PROFILE_DISABLED',
  'DB_UNAVAILABLE',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ErrorScope = Type.Partial(Type.Object({
  host: Type.String(),
  provider: Type.String(),
  workspaceId: Type.String(),
  runId: Type.String(),
  planId: Type.String(),
  attachmentId: Type.String(),
  field: Type.String(),
  /** La capacidad MCP y el servidor que la publica (ADR-009). */
  capability: Type.String(),
  server: Type.String(),
  /** La conversación, cuando el fallo ocurre dentro de un turno de chat. */
  conversationId: Type.String(),
}));
export type ErrorScope = Static<typeof ErrorScope>;

export const ErrorBody = Type.Object({
  error: Type.Object({
    code: Type.Union(ERROR_CODES.map((code) => Type.Literal(code))),
    message: Type.String(),
    /** Si reintentar la misma petición puede funcionar sin cambiar nada. */
    retryable: Type.Boolean(),
    scope: Type.Optional(ErrorScope),
    requestId: Type.String(),
  }),
});
export type ErrorBody = Static<typeof ErrorBody>;

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  DRAFT_VERSION_CONFLICT: 409,
  VALIDATION_FAILED: 400,
  RATE_LIMITED: 429,
  PAYLOAD_TOO_LARGE: 413,
  QUOTA_EXCEEDED: 413,
  HOST_NOT_ALLOWED: 403,
  HOST_UNREACHABLE: 502,
  PROVIDER_MISSING: 409,
  STRATEGY_IMPOSSIBLE: 409,
  TMUX_MISSING: 409,
  RUNNER_LOST: 500,
  RUN_NOT_CANCELLABLE: 409,
  INVALID_TRANSITION: 500,
  INDEX_UNAVAILABLE: 503,
  UPSTREAM_UNAVAILABLE: 502,
  APPROVAL_EXPIRED: 409,
  APPROVAL_CONSUMED: 409,
  PERMISSION_PROFILE_DISABLED: 403,
  DB_UNAVAILABLE: 503,
  INTERNAL: 500,
};

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'RATE_LIMITED',
  'HOST_UNREACHABLE',
  'INDEX_UNAVAILABLE',
  'UPSTREAM_UNAVAILABLE',
  'DB_UNAVAILABLE',
]);

/** El único error que las rutas lanzan a propósito. Todo lo demás es un fallo de programación. */
export class JarvisError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly scope: ErrorScope | undefined;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: { scope?: ErrorScope; retryable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'JarvisError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
    this.scope = options.scope;
    this.retryable = options.retryable ?? RETRYABLE.has(code);
  }

  toBody(requestId: string): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...(this.scope ? { scope: this.scope } : {}),
        requestId,
      },
    };
  }
}

export const statusForCode = (code: ErrorCode): number => STATUS_BY_CODE[code];
