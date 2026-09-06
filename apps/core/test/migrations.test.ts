/**
 * Que una migración que reconstruye una tabla no se lleve por delante lo que colgaba de ella.
 *
 * Esto no se razona, se demuestra. La v18 relaja un `NOT NULL` de `plans`, y en SQLite eso obliga a
 * reconstruir la tabla — con dos hijas apuntando a ella con `ON DELETE CASCADE`. La forma ingenua
 * borra el historial de planes, de pasos y de aprobaciones firmadas, y lo hace **sin error**: la
 * migración pasa, el arranque sigue, y lo que falta no lo echa nadie de menos hasta que alguien va
 * a mirar qué se hizo el mes pasado.
 *
 * Se aplica **dentro de una transacción** a propósito, que es como la ejecuta el runner: fuera de
 * ella `PRAGMA foreign_keys = OFF` funcionaría y la prueba mediría un mundo que no existe.
 */
import { describe, expect, it } from 'vitest';
import type { Database as Db } from 'better-sqlite3';
import { openDatabase } from '../src/platform/db.js';
import { MIGRATIONS } from '../src/platform/migrations.js';

const NOW = '2026-09-06T12:00:00.000Z';

const hasta = (version: number): Db => {
  const db = openDatabase({ path: ':memory:' });
  for (const migration of MIGRATIONS.filter((m) => m.version <= version)) db.exec(migration.sql);
  return db;
};

const aplicar = (db: Db, version: number): void => {
  const migration = MIGRATIONS.find((m) => m.version === version);
  if (!migration) throw new Error(`no existe la migración ${version}`);
  db.transaction(() => db.exec(migration.sql))();
};

const cuantos = (db: Db, tabla: string): number =>
  (db.prepare(`SELECT count(*) n FROM ${tabla}`).get() as { n: number }).n;

function sembrar(db: Db): void {
  db.prepare(`INSERT INTO workspaces
    (id, session_host, provider, session_id, created_by, title, title_source, cwd, cwd_source,
     created_at, updated_at)
    VALUES ('w1','bastion','claude','sid-1','braian','sesión','manual','/srv/app','manual',?,?)`)
    .run(NOW, NOW);

  for (const [id, objetivo] of [['p1', 'poner al día los tres servidores'], ['p0', 'un plan viejo']] as const) {
    db.prepare(`INSERT INTO plans
      (id, workspace_id, created_by, objective, status, current_step, created_at, updated_at, autonomy)
      VALUES (?, 'w1', 'braian', ?, 'running', 1, ?, ?, 'manual')`).run(id, objetivo, NOW, NOW);
  }
  for (const [id, plan, ordinal] of [['s1', 'p1', 0], ['s2', 'p1', 1], ['s3', 'p0', 0]] as const) {
    db.prepare(`INSERT INTO plan_steps
      (id, plan_id, ordinal, kind, status, title, input_json, idempotency_key, attempt)
      VALUES (?, ?, ?, 'estimate', 'ready', 'paso', '{}', ?, 1)`).run(id, plan, ordinal, `k-${id}`);
  }
  db.prepare(`INSERT INTO approvals
    (id, plan_id, run_id, action_type, target_json, action_digest, summary, requested_by,
     requested_at, expires_at, status)
    VALUES ('a1','p1',NULL,'workflow','{}','d1','firmar el plan','braian',?,?,'approved')`)
    .run(NOW, NOW);
}

describe('MIGRACIÓN 18 · relajar `plans.workspace_id` no borra el historial', () => {
  it('conserva planes, pasos y aprobaciones, y las referencias siguen apuntando a algo', () => {
    const db = hasta(17);
    sembrar(db);
    expect([cuantos(db, 'plans'), cuantos(db, 'plan_steps'), cuantos(db, 'approvals')]).toEqual([2, 3, 1]);

    aplicar(db, 18);

    // Contar dice que están. El `foreign_key_check` dice que además apuntan a algo: una tabla
    // reconstruida mal deja filas huérfanas que se leen igual hasta que alguien hace un JOIN.
    expect([cuantos(db, 'plans'), cuantos(db, 'plan_steps'), cuantos(db, 'approvals')]).toEqual([2, 3, 1]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('y a partir de ahí un plan puede no tener sesión, que es para lo que se hizo', () => {
    const db = hasta(17);
    sembrar(db);
    aplicar(db, 18);

    db.prepare(`INSERT INTO plans
      (id, workspace_id, created_by, objective, status, current_step, created_at, updated_at, autonomy)
      VALUES ('p2', NULL, 'braian', 'compara el disco de las tres máquinas', 'draft', 0, ?, ?, 'manual')`)
      .run(NOW, NOW);

    const sinSesion = db.prepare("SELECT workspace_id FROM plans WHERE id='p2'").get() as { workspace_id: null };
    expect(sinSesion.workspace_id).toBeNull();
    db.close();
  });

  it('borrar la sesión ya no borra el plan: el plan es el registro de lo que se hizo', () => {
    const db = hasta(17);
    sembrar(db);
    aplicar(db, 18);

    db.prepare("DELETE FROM workspaces WHERE id='w1'").run();

    // Antes era `ON DELETE CASCADE`: cerrar una sesión se llevaba por delante lo que se hizo en ella.
    expect(cuantos(db, 'plans')).toBe(2);
    expect(cuantos(db, 'plan_steps')).toBe(3);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('no deja tablas de trabajo detrás', () => {
    const db = hasta(17);
    sembrar(db);
    aplicar(db, 18);

    // Las copias existen sólo mientras dura la reconstrucción. Una que sobreviva es una segunda
    // versión del historial esperando a que alguien la lea por error.
    const sobrantes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '\\_%' ESCAPE '\\'",
    ).all();
    expect(sobrantes).toEqual([]);
    db.close();
  });
});
