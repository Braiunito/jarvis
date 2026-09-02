/**
 * Auditoría operacional: append-only en SQLite, exportable a JSONL.
 *
 * El gateway conserva su propio audit.log de seguridad; esto es el otro lado: qué se ejecutó,
 * dónde y con qué permiso. Se guarda el destino efectivo, nunca el prompt ni la salida.
 */
import type { Database as Db } from 'better-sqlite3';
import { newAuditId } from './ids.js';
import type { Clock } from './clock.js';

export interface AuditEntry {
  actorUser: string;
  eventType: string;
  requestId?: string | null;
  workspaceId?: string | null;
  runId?: string | null;
  host?: string | null;
  payload?: Record<string, unknown>;
}

export class AuditLog {
  readonly #db: Db;
  readonly #clock: Clock;

  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  record(entry: AuditEntry): void {
    this.#db.prepare(`INSERT INTO audit_events
      (id, at, actor_user, event_type, request_id, workspace_id, run_id, host, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      newAuditId(),
      this.#clock.nowIso(),
      entry.actorUser,
      entry.eventType,
      entry.requestId ?? null,
      entry.workspaceId ?? null,
      entry.runId ?? null,
      entry.host ?? null,
      JSON.stringify(entry.payload ?? {}),
    );
  }

  recent(limit = 100): Array<Record<string, unknown>> {
    return this.#db.prepare('SELECT * FROM audit_events ORDER BY at DESC LIMIT ?')
      .all(limit) as Array<Record<string, unknown>>;
  }
}
