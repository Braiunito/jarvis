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
  /** Turnos de la persona que dicen algo: ni resultados de herramienta ni envoltorios de comando. */
  user_text_messages?: number;
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
  transcript(ref: SessionRef, options?: { last?: number }): Promise<{ messages: Array<{ role: string; at: string | null; text: string }>; truncated: boolean; messageCount?: number | null; preview?: string | null }>;
  health(): Promise<{ ok: boolean; error: string | null; lastOkAt: string | null }>;
  /** Cuándo barrió el índice. Opcional: uno antiguo no lo expone y se degrada a «no lo sé». */
  status?(): Promise<{ lastScanAt: string | null }>;
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
    workspaceTitle: null,
    /*
     * Nadie habló aquí.
     *
     * Con un índice que ya cuenta los turnos con texto real, esto incluye las sesiones cuyo único
     * contenido son envoltorios de comando —las que acaban llamándose `Claude <hash>`—. Con uno
     * antiguo, que no lo cuenta, degrada a la regla de siempre: cero mensajes de los dos lados.
     */
    empty: (row.assistant_messages ?? 0) === 0 && (
      row.user_text_messages === undefined
        ? (row.user_messages ?? 0) === 0
        : row.user_text_messages === 0
    ),
    /*
     * Aquí no se sabe todavía.
     *
     * Una sesión vacía **puede** ser perfectamente utilizable: si la estrenó Jarvis y aún no ha
     * corrido su primer trabajo, está vacía porque todavía no existe al otro lado. Eso lo sabe el
     * workspace, que se cruza más adelante, así que este valor se corrige allí y no aquí.
     */
    resumable: true,
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

  async transcript(ref: SessionRef, { last }: { last?: number } = {}): Promise<{ messages: Array<{ role: string; at: string | null; text: string }>; truncated: boolean; messageCount: number | null; preview: string | null }> {
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
      // Cuántos mensajes tiene la sesión, no cuántos cabían en esta página. La fila del índice ya
      // se ha buscado para resolver la clave, así que el dato sale gratis.
      messageCount: (row.user_messages ?? 0) + (row.assistant_messages ?? 0),
      // El índice ya guarda el primer turno aprovechable de la sesión: pedirlo aparte sería una
      // consulta de más para un dato que viene en la fila que acabamos de leer.
      preview: row.preview ?? null,
    };
  }

  async status(): Promise<{ lastScanAt: string | null }> {
    try {
      const payload = await this.#get<{ lastScanAt?: string | null }>('/api/status', {});
      return { lastScanAt: payload.lastScanAt ?? null };
    } catch {
      // Un índice sin `/api/status` es uno viejo, no uno roto: se degrada a «no lo sé».
      return { lastScanAt: null };
    }
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
/**
 * Frescura por host, con el bastión contado una sola vez.
 *
 * El índice llama `local` a la máquina donde corre, que para Jarvis **es** el bastión. Si además
 * tiene sesiones indexadas bajo el nombre propio del bastión, sin fusionar salen dos filas con el
 * mismo nombre y distinta antigüedad, y la interfaz enseña «zeus ok hace 2 días · zeus ok hace 13
 * horas» sin que nadie pueda saber cuál es la buena.
 */
export function freshnessFrom(rows: IndexHostRow[], bastionHost: string, now: number, stale: boolean, error: string | null): HostFreshness[] {
  const byHost = new Map<string, HostFreshness>();
  for (const row of rows) {
    const lastSync = row.last_activity ?? row.updated_at ?? null;
    const ageSeconds = lastSync ? Math.max(0, Math.round((now - Date.parse(lastSync)) / 1000)) : null;
    const host = normalizeHost(row.host, bastionHost);
    const entry: HostFreshness = {
      host,
      lastSyncAt: lastSync,
      ageSeconds,
      sessionCount: row.sessions ?? 0,
      status: error ? 'failed' : stale ? 'stale' : 'ok',
      error,
    };
    const previous = byHost.get(host);
    if (!previous) {
      byHost.set(host, entry);
      continue;
    }
    // Al fusionar se suman las sesiones y se conserva la actividad más reciente: eso es lo que
    // significa «cuándo se supo por última vez algo de esta máquina».
    const newer = (entry.ageSeconds ?? Number.POSITIVE_INFINITY) < (previous.ageSeconds ?? Number.POSITIVE_INFINITY)
      ? entry : previous;
    byHost.set(host, {
      ...newer,
      sessionCount: previous.sessionCount + entry.sessionCount,
    });
  }
  return [...byHost.values()];
}
