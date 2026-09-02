/**
 * Cliente del índice aiSessions.
 *
 * aiSessions es de sólo lectura y su base es una caché reconstruible: Jarvis guarda `SessionRef`,
 * jamás un rowid ni un path interno del índice (ADR-005). Cuando el índice no responde se
 * conserva el último resultado bueno y se dice que está viejo, porque una pantalla vieja y
 * fechada sigue sirviendo y una vacía no.
 *
 * Contratos INDEX-SESSION-01, INDEX-FRESH-01.
 */
import type { HostFreshness, Provider, SessionRef, SessionSummary } from '@jarvis/contracts';
import { JarvisError } from '@jarvis/contracts';

/** Una fila del índice, tal y como la sirve `aisessions serve`. */
export interface IndexRow {
  session_key: string;
  host: string;
  provider: string;
  session_id: string;
  path: string;
  source_root: string;
  cwd: string;
  title: string;
  preview: string;
  created_at: string | null;
  updated_at: string | null;
  model: string;
  size_bytes: number;
  user_messages: number;
  assistant_messages: number;
  indexed_at: string;
}

export interface IndexHostRow {
  host: string;
  sessions: number;
  last_activity?: string | null;
  updated_at?: string | null;
}

export interface SessionQuery {
  q?: string | undefined;
  host?: string | undefined;
  provider?: Provider | undefined;
  cwd?: string | undefined;
  limit?: number | undefined;
  since?: string | undefined;
}

export interface SessionIndex {
  list(query: SessionQuery): Promise<{ rows: IndexRow[]; stale: boolean; error: string | null }>;
  hosts(): Promise<{ rows: IndexHostRow[]; stale: boolean; error: string | null }>;
  transcript(ref: SessionRef, options?: { last?: number }): Promise<{ messages: Array<{ role: string; at: string | null; text: string }>; truncated: boolean }>;
  health(): Promise<{ ok: boolean; error: string | null; lastOkAt: string | null }>;
}

/**
 * El alias `local` del índice significa «la máquina desde la que se indexó», que para Jarvis es
 * el bastión. Se normaliza aquí, en el límite de entrada, y no vuelve a aparecer.
 */
export const normalizeHost = (host: string, bastionHost: string): string =>
  !host || host === 'local' ? bastionHost : host;

export function rowToSummary(row: IndexRow, bastionHost: string): SessionSummary {
  return {
    ref: {
      host: normalizeHost(row.host, bastionHost),
      provider: row.provider as Provider,
      sessionId: row.session_id,
    },
    title: row.title || null,
    cwd: row.cwd || null,
    sourceRoot: row.source_root || null,
    messageCount: (row.user_messages ?? 0) + (row.assistant_messages ?? 0),
    startedAt: row.created_at || null,
    lastActivityAt: row.updated_at || null,
    preview: row.preview || null,
    workspaceId: null,
  };
}

interface CacheEntry<T> { at: number; value: T }

export class HttpSessionIndex implements SessionIndex {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #lastGood = new Map<string, CacheEntry<unknown>>();
  #lastOkAt: string | null = null;
  #lastError: string | null = null;

  constructor({ baseUrl, token = '', timeoutMs = 10_000 }: { baseUrl: string; token?: string; timeoutMs?: number }) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#token = token;
    this.#timeoutMs = timeoutMs;
  }

  async #get<T>(path: string, search: Record<string, string | undefined> = {}): Promise<T> {
    const url = new URL(`${this.#baseUrl}${path}`);
    for (const [key, value] of Object.entries(search)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, value);
    }
    if (this.#token) url.searchParams.set('token', this.#token);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`index responded ${response.status}`);
      }
      const body = (await response.json()) as T;
      this.#lastOkAt = new Date().toISOString();
      this.#lastError = null;
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Devuelve el último resultado bueno cuando la llamada falla, marcándolo como viejo. */
  async #withFallback<T>(key: string, fetcher: () => Promise<T>): Promise<{ rows: T; stale: boolean; error: string | null }> {
    try {
      const value = await fetcher();
      this.#lastGood.set(key, { at: Date.now(), value });
      return { rows: value, stale: false, error: null };
    } catch (error) {
      const message = (error as Error).name === 'AbortError'
        ? `the index did not answer in ${this.#timeoutMs}ms`
        : (error as Error).message;
      this.#lastError = message;
      const cached = this.#lastGood.get(key);
      if (cached) return { rows: cached.value as T, stale: true, error: message };
      throw new JarvisError('INDEX_UNAVAILABLE', `the session index is unavailable: ${message}`);
    }
  }

  async list(query: SessionQuery): Promise<{ rows: IndexRow[]; stale: boolean; error: string | null }> {
    const key = JSON.stringify(query);
    const search = {
      provider: query.provider,
      host: query.host,
      cwd: query.cwd,
      since: query.since,
      limit: String(query.limit ?? 50),
    };
    return this.#withFallback(key, () => (query.q
      ? this.#get<IndexRow[]>('/api/search', { ...search, q: query.q })
      : this.#get<IndexRow[]>('/api/sessions', search)));
  }

  async hosts(): Promise<{ rows: IndexHostRow[]; stale: boolean; error: string | null }> {
    return this.#withFallback('hosts', () => this.#get<IndexHostRow[]>('/api/hosts'));
  }

  async transcript(ref: SessionRef, { last }: { last?: number } = {}): Promise<{ messages: Array<{ role: string; at: string | null; text: string }>; truncated: boolean }> {
    // El índice indexa por `session_key`; se localiza por el id, que es lo único que Jarvis guarda.
    const listed = await this.#get<IndexRow[]>('/api/sessions', { limit: '500', host: ref.host, provider: ref.provider });
    const row = listed.find((candidate) => candidate.session_id === ref.sessionId);
    if (!row) throw new JarvisError('NOT_FOUND', `the index does not know session ${ref.sessionId}`);
    const payload = await this.#get<{ messages?: Array<{ role: string; at?: string; timestamp?: string; text: string }>; truncated?: boolean }>(
      `/api/export/${encodeURIComponent(row.session_key)}`,
      { format: 'json', ...(last ? { last: String(last) } : {}) },
    );
    return {
      messages: (payload.messages ?? []).map((message) => ({
        role: message.role,
        at: message.at ?? message.timestamp ?? null,
        text: message.text,
      })),
      truncated: Boolean(payload.truncated),
    };
  }

  async health(): Promise<{ ok: boolean; error: string | null; lastOkAt: string | null }> {
    try {
      await this.#get<{ ok: boolean }>('/api/health');
      return { ok: true, error: null, lastOkAt: this.#lastOkAt };
    } catch (error) {
      return { ok: false, error: (error as Error).message, lastOkAt: this.#lastOkAt };
    }
  }

  get lastError(): string | null { return this.#lastError; }
}

/** Frescura por host, derivada de lo que el índice sabe de cada uno. */
export function freshnessFrom(rows: IndexHostRow[], bastionHost: string, now: number, stale: boolean, error: string | null): HostFreshness[] {
  return rows.map((row) => {
    const lastSync = row.last_activity ?? row.updated_at ?? null;
    const ageSeconds = lastSync ? Math.max(0, Math.round((now - Date.parse(lastSync)) / 1000)) : null;
    return {
      host: normalizeHost(row.host, bastionHost),
      lastSyncAt: lastSync,
      ageSeconds,
      sessionCount: row.sessions ?? 0,
      status: error ? 'failed' : stale ? 'stale' : 'ok',
      error,
    };
  });
}
