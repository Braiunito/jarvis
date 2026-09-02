/**
 * Persistencia de runs y de su event log.
 *
 * Dos invariantes viven aquí y en ningún otro sitio:
 *   · insertar un evento y avanzar `last_event_seq` ocurre en la misma transacción;
 *   · `remote_cursor_bytes` (cómo lee el core) y `seq` (identidad pública) son cosas distintas.
 */
import type { Database as Db } from 'better-sqlite3';
import type { Run, RunEvent, RunEventType, RunStatus } from '@jarvis/contracts';

export interface RunRow {
  id: string;
  workspace_id: string;
  created_by: string;
  provider: string;
  session_id: string | null;
  prompt: string;
  work_host: string;
  execution_host: string;
  strategy: string;
  strategy_reason: string | null;
  cwd: string | null;
  permission_profile: string;
  model: string | null;
  status: string;
  attempt: number;
  parent_run_id: string | null;
  remote_name: string | null;
  remote_spool_dir: string | null;
  remote_cursor_bytes: number;
  last_event_seq: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  cancel_requested_at: string | null;
  deadline_at: string | null;
  exit_code: number | null;
  error_code: string | null;
  error_message: string | null;
  result_ok: number | null;
  result_summary: string | null;
}

export const toRun = (row: RunRow): Run => ({
  id: row.id,
  workspaceId: row.workspace_id,
  createdBy: row.created_by,
  provider: row.provider as Run['provider'],
  sessionId: row.session_id,
  workHost: row.work_host,
  executionHost: row.execution_host,
  strategy: row.strategy as Run['strategy'],
  strategyReason: row.strategy_reason,
  cwd: row.cwd,
  permissionProfile: row.permission_profile as Run['permissionProfile'],
  model: row.model,
  status: row.status as RunStatus,
  attempt: row.attempt,
  parentRunId: row.parent_run_id,
  remoteName: row.remote_name,
  lastEventSeq: row.last_event_seq,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  cancelRequestedAt: row.cancel_requested_at,
  exitCode: row.exit_code,
  errorCode: row.error_code,
  errorMessage: row.error_message,
  resultOk: row.result_ok === null ? null : row.result_ok === 1,
  resultSummary: row.result_summary,
});

export interface NewRunRecord {
  id: string;
  workspaceId: string;
  createdBy: string;
  provider: string;
  sessionId: string | null;
  prompt: string;
  workHost: string;
  executionHost: string;
  strategy: string;
  strategyReason: string | null;
  cwd: string | null;
  permissionProfile: string;
  model: string | null;
  attempt: number;
  parentRunId: string | null;
  remoteName: string;
  remoteSpoolDir: string;
  createdAt: string;
  deadlineAt: string | null;
}

export interface EventInput {
  type: RunEventType;
  payload: unknown;
  at: string;
}

export class RunRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  get db(): Db { return this.#db; }

  insert(record: NewRunRecord): void {
    this.#db.prepare(`INSERT INTO runs
      (id, workspace_id, created_by, provider, session_id, prompt, work_host, execution_host,
       strategy, strategy_reason, cwd, permission_profile, model, status, attempt, parent_run_id,
       remote_name, remote_spool_dir, remote_cursor_bytes, last_event_seq, created_at, deadline_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, 0, -1, ?, ?)`).run(
      record.id, record.workspaceId, record.createdBy, record.provider, record.sessionId,
      record.prompt, record.workHost, record.executionHost, record.strategy, record.strategyReason,
      record.cwd, record.permissionProfile, record.model, record.attempt, record.parentRunId,
      record.remoteName, record.remoteSpoolDir, record.createdAt, record.deadlineAt,
    );
  }

  row(runId: string): RunRow | null {
    return (this.#db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as RunRow | undefined) ?? null;
  }

  find(runId: string): Run | null {
    const row = this.row(runId);
    return row ? toRun(row) : null;
  }

  listByWorkspace(workspaceId: string, limit = 50): Run[] {
    return (this.#db.prepare('SELECT * FROM runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(workspaceId, limit) as RunRow[]).map(toRun);
  }

  listRecent(limit = 50): Run[] {
    return (this.#db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?')
      .all(limit) as RunRow[]).map(toRun);
  }

  listByStatus(statuses: readonly RunStatus[]): Run[] {
    const placeholders = statuses.map(() => '?').join(', ');
    return (this.#db.prepare(`SELECT * FROM runs WHERE status IN (${placeholders}) ORDER BY created_at`)
      .all(...statuses) as RunRow[]).map(toRun);
  }

  countActive(): number {
    return (this.#db.prepare(
      "SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','preparing','running','waiting','cancelling')",
    ).get() as { n: number }).n;
  }

  events(runId: string, { afterSeq = -1, limit = 5000 }: { afterSeq?: number; limit?: number } = {}): RunEvent[] {
    const rows = this.#db.prepare(
      'SELECT run_id, seq, at, type, payload_json, compacted FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?',
    ).all(runId, afterSeq, limit) as Array<{ run_id: string; seq: number; at: string; type: string; payload_json: string; compacted: number }>;
    return rows.map((row) => ({
      runId: row.run_id,
      seq: row.seq,
      at: row.at,
      type: row.type as RunEventType,
      payload: JSON.parse(row.payload_json) as unknown,
      ...(row.compacted ? { compacted: true } : {}),
    }));
  }

  /**
   * Confirma un lote: eventos, cursor y estado en una sola transacción.
   *
   * Si el proceso muere antes del commit se releen bytes; si muere después, el cursor persistido
   * evita duplicarlos. Esa es toda la defensa contra eventos repetidos, y por eso vive junta.
   */
  appendBatch(runId: string, events: EventInput[], patch: {
    cursorBytes?: number;
    status?: RunStatus;
    startedAt?: string | null;
    finishedAt?: string | null;
    exitCode?: number | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    resultOk?: boolean | null;
    resultSummary?: string | null;
    sessionId?: string | null;
    cancelRequestedAt?: string | null;
  } = {}): { firstSeq: number; lastSeq: number } {
    return this.#db.transaction(() => {
      const row = this.row(runId);
      if (!row) throw new Error(`unknown run ${runId}`);
      let seq = row.last_event_seq;
      const insert = this.#db.prepare(
        'INSERT INTO run_events (run_id, seq, at, type, payload_json, payload_bytes) VALUES (?, ?, ?, ?, ?, ?)',
      );
      const firstSeq = seq + 1;
      for (const event of events) {
        seq += 1;
        const json = JSON.stringify(event.payload ?? null);
        insert.run(runId, seq, event.at, event.type, json, Buffer.byteLength(json, 'utf8'));
      }

      const sets: string[] = ['last_event_seq = ?'];
      const values: unknown[] = [seq];
      const set = (column: string, value: unknown): void => { sets.push(`${column} = ?`); values.push(value); };

      if (patch.cursorBytes !== undefined) set('remote_cursor_bytes', patch.cursorBytes);
      if (patch.status !== undefined) set('status', patch.status);
      if (patch.startedAt !== undefined) set('started_at', patch.startedAt);
      if (patch.finishedAt !== undefined) set('finished_at', patch.finishedAt);
      if (patch.exitCode !== undefined) set('exit_code', patch.exitCode);
      if (patch.errorCode !== undefined) set('error_code', patch.errorCode);
      if (patch.errorMessage !== undefined) set('error_message', patch.errorMessage);
      if (patch.resultOk !== undefined) set('result_ok', patch.resultOk === null ? null : patch.resultOk ? 1 : 0);
      if (patch.resultSummary !== undefined) set('result_summary', patch.resultSummary);
      if (patch.sessionId !== undefined) set('session_id', patch.sessionId);
      if (patch.cancelRequestedAt !== undefined) set('cancel_requested_at', patch.cancelRequestedAt);

      values.push(runId);
      this.#db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...values);
      return { firstSeq, lastSeq: seq };
    })();
  }

  updateCursor(runId: string, cursorBytes: number): void {
    this.#db.prepare('UPDATE runs SET remote_cursor_bytes = ? WHERE id = ?').run(cursorBytes, runId);
  }

  // ---- idempotencia -------------------------------------------------------

  findIdempotent(scope: string, key: string): { requestHash: string; resourceId: string | null; responseJson: string | null } | null {
    const row = this.#db.prepare(
      'SELECT request_hash, resource_id, response_json FROM idempotency_keys WHERE scope = ? AND key = ?',
    ).get(scope, key) as { request_hash: string; resource_id: string | null; response_json: string | null } | undefined;
    if (!row) return null;
    return { requestHash: row.request_hash, resourceId: row.resource_id, responseJson: row.response_json };
  }

  saveIdempotent(scope: string, key: string, requestHash: string, resource: { type: string; id: string }, responseJson: string, createdAt: string, expiresAt: string): void {
    this.#db.prepare(`INSERT INTO idempotency_keys
      (scope, key, request_hash, resource_type, resource_id, response_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (scope, key) DO UPDATE SET response_json = excluded.response_json`)
      .run(scope, key, requestHash, resource.type, resource.id, responseJson, createdAt, expiresAt);
  }
}
