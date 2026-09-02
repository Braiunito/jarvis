/**
 * Un índice de sesiones falso, con la misma forma que sirve `aisessions serve`.
 *
 * Permite ejercitar «el índice está viejo», «el índice no responde» y «apareció una sesión nueva»
 * sin levantar el sidecar Python.
 */
export interface FakeIndexRow {
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

export const indexRow = (overrides: Partial<FakeIndexRow> = {}): FakeIndexRow => ({
  session_key: 'local:claude:sid-1',
  host: 'local',
  provider: 'claude',
  session_id: 'sid-1',
  path: '/home/dev/.claude/projects/app/sid-1.jsonl',
  source_root: '/home/dev/.claude',
  cwd: '/srv/app',
  title: 'arreglar el timeout del pool',
  preview: 'el pool se queda sin conexiones a las 3am',
  created_at: '2026-08-30T10:00:00.000Z',
  updated_at: '2026-09-01T18:04:00.000Z',
  model: 'claude-opus-5',
  size_bytes: 4096,
  user_messages: 3,
  assistant_messages: 4,
  indexed_at: '2026-09-01T18:05:00.000Z',
  ...overrides,
});

export class FakeSessionIndex {
  rows: FakeIndexRow[];
  hostRows: Array<{ host: string; sessions: number; last_activity: string | null }>;
  /** Cuando se pone, toda llamada falla: así se prueba el camino de «último dato bueno». */
  failWith: string | null = null;
  transcripts = new Map<string, Array<{ role: string; at: string | null; text: string }>>();

  constructor(rows: FakeIndexRow[] = [indexRow()]) {
    this.rows = rows;
    this.hostRows = [{ host: 'local', sessions: rows.length, last_activity: '2026-09-01T18:04:00.000Z' }];
  }

  #maybeFail(): void {
    if (this.failWith) throw new Error(this.failWith);
  }

  async list(query: { q?: string; host?: string; provider?: string; limit?: number }): Promise<{ rows: FakeIndexRow[]; stale: boolean; error: string | null }> {
    try {
      this.#maybeFail();
    } catch (error) {
      return { rows: this.rows, stale: true, error: (error as Error).message };
    }
    let rows = this.rows;
    if (query.provider) rows = rows.filter((row) => row.provider === query.provider);
    if (query.host && query.host !== 'all') rows = rows.filter((row) => row.host === query.host || (query.host === 'bastion' && row.host === 'local'));
    if (query.q) {
      const needle = query.q.toLowerCase();
      rows = rows.filter((row) => `${row.title} ${row.preview}`.toLowerCase().includes(needle));
    }
    return { rows: rows.slice(0, query.limit ?? 50), stale: false, error: null };
  }

  async hosts(): Promise<{ rows: Array<{ host: string; sessions: number; last_activity: string | null }>; stale: boolean; error: string | null }> {
    try {
      this.#maybeFail();
    } catch (error) {
      return { rows: this.hostRows, stale: true, error: (error as Error).message };
    }
    return { rows: this.hostRows, stale: false, error: null };
  }

  async transcript(ref: { host: string; provider: string; sessionId: string }): Promise<{ messages: Array<{ role: string; at: string | null; text: string }>; truncated: boolean; messageCount: number | null }> {
    this.#maybeFail();
    const row = this.rows.find((candidate) => candidate.session_id === ref.sessionId);
    return {
      messages: this.transcripts.get(ref.sessionId) ?? [
        { role: 'user', at: '2026-08-30T10:00:00.000Z', text: 'el pool se queda sin conexiones' },
        { role: 'assistant', at: '2026-08-30T10:00:20.000Z', text: 'miro el log de la aplicación' },
      ],
      truncated: false,
      // Los que tiene la sesión según el índice, que no son los que caben en una página.
      messageCount: row ? (row.user_messages ?? 0) + (row.assistant_messages ?? 0) : null,
    };
  }

  async health(): Promise<{ ok: boolean; error: string | null; lastOkAt: string | null }> {
    return this.failWith
      ? { ok: false, error: this.failWith, lastOkAt: null }
      : { ok: true, error: null, lastOkAt: new Date().toISOString() };
  }
}
