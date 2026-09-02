/**
 * El cliente HTTP.
 *
 * Todo error de la API llega con `code`, `retryable` y `requestId`: la interfaz decide por el
 * código, nunca por el texto del mensaje, que está escrito para una persona.
 */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    retryable: boolean;
    scope?: Record<string, string>;
    requestId: string;
  };
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly requestId: string;
  readonly scope: Record<string, string> | undefined;

  constructor(status: number, body: ApiErrorBody['error']) {
    super(body.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = body.code;
    this.retryable = body.retryable;
    this.requestId = body.requestId;
    this.scope = body.scope;
  }
}

/** Se lanza cuando la sesión ya no vale: la aplicación entera vuelve al login. */
export class UnauthenticatedError extends Error {
  override name = 'UnauthenticatedError';
}

async function parseError(response: Response): Promise<never> {
  let body: ApiErrorBody | { error?: string } | null = null;
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    body = null;
  }
  if (response.status === 401) throw new UnauthenticatedError('authentication required');
  if (body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object') {
    throw new ApiError(response.status, body.error as ApiErrorBody['error']);
  }
  const legacyMessage = (body as unknown as { error?: unknown } | null)?.error;
  throw new ApiError(response.status, {
    code: 'INTERNAL',
    message: typeof legacyMessage === 'string' ? legacyMessage : `request failed with ${response.status}`,
    retryable: response.status >= 500,
    requestId: response.headers.get('x-request-id') ?? 'unknown',
  });
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init.body && !(init.body instanceof Blob) ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
    credentials: 'same-origin',
  });
  if (!response.ok) await parseError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const get = <T>(path: string): Promise<T> => api<T>(path);
export const post = <T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T> =>
  api<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body), ...(headers ? { headers } : {}) });
export const put = <T>(path: string, body: unknown): Promise<T> =>
  api<T>(path, { method: 'PUT', body: JSON.stringify(body) });
