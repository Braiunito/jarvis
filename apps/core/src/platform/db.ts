/**
 * SQLite: la verdad operativa del core (ADR-002).
 *
 * Un solo escritor lógico, WAL para que los lectores no se bloqueen, y `synchronous = FULL`
 * porque preferimos durabilidad del event log a unos milisegundos de throughput: Jarvis no es un
 * sistema de ingesta masiva.
 *
 * Regla que no se rompe: una transacción valida estado, escribe pocas filas y confirma. Nunca se
 * espera dentro de ella a SSH ni a un modelo.
 */
import Database, { type Database as Db } from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { MIGRATIONS } from './migrations.js';

/** El bug de reset de WAL de marzo de 2026 se corrigió aquí; por debajo no se arranca. */
const MINIMUM_SQLITE = [3, 51, 3] as const;

export class DatabaseError extends Error {
  override name = 'DatabaseError';
}

function assertSqliteVersion(db: Db): string {
  const version = (db.prepare('select sqlite_version() as v').get() as { v: string }).v;
  const parts = version.split('.').map(Number) as [number, number, number];
  for (let i = 0; i < 3; i += 1) {
    const actual = parts[i] ?? 0;
    const required = MINIMUM_SQLITE[i] as number;
    if (actual > required) break;
    if (actual < required) {
      throw new DatabaseError(
        `SQLite ${version} is older than the required ${MINIMUM_SQLITE.join('.')}: `
        + 'that version fixes a WAL reset bug that can corrupt the database under concurrency',
      );
    }
  }
  return version;
}

export interface OpenOptions {
  path: string;
  readonly?: boolean;
  /** Sólo para tests: comprobar la versión mínima es un requisito de producción. */
  skipVersionCheck?: boolean;
}

export function openDatabase({ path, readonly = false, skipVersionCheck = false }: OpenOptions): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { readonly });
  if (!skipVersionCheck) assertSqliteVersion(db);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

export interface AppliedMigration {
  version: number;
  name: string;
  applied_at: string;
  checksum: string;
}

/**
 * Aplica las migraciones pendientes.
 *
 * Cada una se aplica una vez y su checksum se valida: editar una migración ya aplicada es un
 * error, no una actualización. Si la base trae un esquema más nuevo que este binario, el proceso
 * se niega a escribir en lugar de adivinar.
 */
export function migrate(db: Db): { applied: number[]; version: number } {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    checksum TEXT NOT NULL
  )`);

  const existing = db.prepare('SELECT version, name, applied_at, checksum FROM schema_migrations ORDER BY version')
    .all() as AppliedMigration[];
  const byVersion = new Map(existing.map((row) => [row.version, row]));

  const highestKnown = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
  const highestApplied = existing.reduce((max, row) => Math.max(max, row.version), 0);
  if (highestApplied > highestKnown) {
    throw new DatabaseError(
      `the database is at schema ${highestApplied} but this build only knows ${highestKnown}: `
      + 'refusing to run against a newer schema',
    );
  }

  const applied: number[] = [];
  const insert = db.prepare('INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)');

  for (const migration of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    const checksum = createHash('sha256').update(migration.sql).digest('hex').slice(0, 32);
    const previous = byVersion.get(migration.version);
    if (previous) {
      if (previous.checksum !== checksum) {
        throw new DatabaseError(
          `migration ${migration.version} (${migration.name}) changed after being applied: `
          + 'write a new migration instead of editing history',
        );
      }
      continue;
    }
    db.transaction(() => {
      db.exec(migration.sql);
      insert.run(migration.version, migration.name, new Date().toISOString(), checksum);
    })();
    applied.push(migration.version);
  }

  return { applied, version: highestKnown };
}

export function integrityCheck(db: Db): string {
  return (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
}
