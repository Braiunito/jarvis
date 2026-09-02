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
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
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

/**
 * Una copia puede venir en un manifiesto o en dos.
 *
 * Cuando se hace desde el stack desplegado, la base sale del contenedor del core y el almacén de
 * autenticación del gateway —ningún contenedor ve las dos mitades—, así que cada mitad trae su
 * `manifest-core.json` o `manifest-auth.json`. Una copia hecha de una sola vez trae el
 * `manifest.json` de siempre, y ése manda si está.
 */
function loadManifest(dir) {
  if (!existsSync(dir)) return null;
  const names = existsSync(join(dir, 'manifest.json'))
    ? ['manifest.json']
    : readdirSync(dir).filter((name) => /^manifest-.+\.json$/.test(name)).sort();
  if (!names.length) return null;

  const merged = { createdAt: null, files: [], warnings: [], parts: names };
  for (const name of names) {
    const part = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    merged.files.push(...(part.files ?? []));
    merged.warnings.push(...(part.warnings ?? []));
    // La copia es tan vieja como su mitad más vieja: es lo que hay que mirar para saber si sirve.
    if (part.createdAt && (!merged.createdAt || part.createdAt < merged.createdAt)) {
      merged.createdAt = part.createdAt;
    }
  }
  return merged;
}

const manifest = from ? loadManifest(from) : null;
if (!manifest) {
  console.error('uso: restore.mjs --from=<directorio de backup> [--core-db=…] [--auth-dir=…] [--force]');
  console.error('  el directorio necesita un manifest.json, o los manifest-core.json / manifest-auth.json');
  process.exit(2);
}
if (manifest.parts.length > 1) {
  console.log(`[restore] copia en ${manifest.parts.length} mitades: ${manifest.parts.join(' + ')}`);
}
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

/**
 * Media copia se restaura, pero se dice.
 *
 * Restaurar sólo la base deja un stack al que no puede entrar nadie —las passkeys viven en
 * `users.json`— y restaurar sólo la autenticación deja a todo el mundo mirando una base vacía.
 * Las dos cosas se pueden querer a propósito; ninguna se puede descubrir después.
 */
const tiene = (label) => manifest.files.some((file) => file.label === label);
if (!tiene('core-db')) console.warn('[restore] AVISO: esta copia no trae la base del core');
if (!tiene('auth')) console.warn('[restore] AVISO: esta copia no trae el almacén de autenticación');

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
