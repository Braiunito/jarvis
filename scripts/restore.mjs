#!/usr/bin/env node
/**
 * Restaurar una copia, verificándola.
 *
 * Un backup que nunca se ha restaurado es una hipótesis, así que esto no sólo copia: comprueba
 * los checksums del manifiesto y pasa `integrity_check` sobre la base antes de dar nada por bueno.
 *
 * Nunca escribe encima de un destino que ya tenga datos salvo que se lo pidan con `--force`:
 * restaurar sobre una instalación viva es la manera de perder las dos copias a la vez.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = new Map();
for (const argument of process.argv.slice(2)) {
  const [key, value] = argument.replace(/^--/, '').split('=');
  args.set(key, value ?? 'true');
}

const from = resolve(args.get('from') ?? '');
const coreDb = resolve(args.get('core-db') ?? './restored/core/core.db');
const authDir = resolve(args.get('auth-dir') ?? './restored/gateway');
const force = args.get('force') === 'true';

if (!from || !existsSync(join(from, 'manifest.json'))) {
  console.error('uso: restore.mjs --from=<directorio de backup> [--core-db=…] [--auth-dir=…] [--force]');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(join(from, 'manifest.json'), 'utf8'));
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

for (const file of manifest.files) {
  const source = join(from, file.name);
  if (!existsSync(source)) {
    console.error(`[restore] falta ${file.name}, que el manifiesto declara`);
    process.exit(1);
  }
  if (digest(source) !== file.sha256) {
    console.error(`[restore] ${file.name} no coincide con su checksum: la copia está corrupta`);
    process.exit(1);
  }
}
console.log(`[restore] ${manifest.files.length} ficheros verificados contra el manifiesto`);

if ((existsSync(coreDb) || existsSync(join(authDir, 'users.json'))) && !force) {
  console.error('[restore] el destino ya tiene datos; usa --force sólo si de verdad quieres pisarlos');
  process.exit(1);
}

mkdirSync(resolve(coreDb, '..'), { recursive: true });
mkdirSync(authDir, { recursive: true });

for (const file of manifest.files) {
  const source = join(from, file.name);
  const target = file.label === 'core-db' ? coreDb : join(authDir, file.name);
  copyFileSync(source, target);
}

const db = new Database(coreDb, { readonly: true });
const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
const counts = {
  workspaces: db.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n,
  runs: db.prepare('SELECT COUNT(*) AS n FROM runs').get().n,
  events: db.prepare('SELECT COUNT(*) AS n FROM run_events').get().n,
  plans: db.prepare('SELECT COUNT(*) AS n FROM plans').get().n,
};
const schema = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version;
db.close();

if (integrity !== 'ok') {
  console.error(`[restore] la base restaurada no pasa integrity_check: ${integrity}`);
  process.exit(1);
}

console.log(`[restore] integrity_check ok · esquema ${schema}`);
console.log(`[restore] contenido: ${JSON.stringify(counts)}`);
console.log(`[restore] core.db en ${coreDb}`);
console.log(`[restore] autenticación en ${authDir}`);
console.log('[restore] arranca el stack contra este destino y pasa el smoke antes de abrir tráfico');
