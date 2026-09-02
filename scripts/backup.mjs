#!/usr/bin/env node
/**
 * Copia de seguridad del estado que no se puede reconstruir.
 *
 * Entra: la base del core, el almacén de autenticación del gateway (usuarios, passkeys, claves de
 * sesión y de identidad interna) y su registro de auditoría. No entra: el índice de aiSessions
 * —es una caché que se rehace— ni los adjuntos, que son efímeros por diseño.
 *
 * La base se copia con `VACUUM INTO`, que produce un fichero consistente aunque haya escrituras
 * en curso. Copiar el fichero a pelo mientras el WAL se mueve es la forma clásica de guardar una
 * base rota y no enterarse hasta el día que hace falta.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

const args = new Map();
for (const argument of process.argv.slice(2)) {
  const [key, value] = argument.replace(/^--/, '').split('=');
  args.set(key, value ?? 'true');
}

const coreDb = resolve(args.get('core-db') ?? process.env.JARVIS_CORE_DB ?? '/var/lib/jarvis-core/core.db');
const authDir = resolve(args.get('auth-dir') ?? process.env.JARVIS_DATA_DIR ?? '/var/lib/jarvis');
const outDir = resolve(args.get('out') ?? `./backups/${new Date().toISOString().replace(/[:.]/g, '-')}`);

mkdirSync(outDir, { recursive: true });
const manifest = { createdAt: new Date().toISOString(), files: [], warnings: [] };

const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

const record = (label, path) => {
  manifest.files.push({ label, name: basename(path), bytes: statSync(path).size, sha256: digest(path) });
};

// --- base del core ---------------------------------------------------------
if (existsSync(coreDb)) {
  const target = join(outDir, 'core.db');
  const db = new Database(coreDb, { readonly: true });
  const integrity = db.prepare('PRAGMA integrity_check').get().integrity_check;
  if (integrity !== 'ok') {
    console.error(`[backup] la base de origen no pasa integrity_check: ${integrity}`);
    process.exit(1);
  }
  // SQLite quiere comillas simples para un literal de cadena: con dobles lo lee como un nombre
  // de columna y responde algo tan desconcertante como "no such column".
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  db.close();
  record('core-db', target);
  console.log(`[backup] core.db copiada y verificada`);
} else {
  manifest.warnings.push(`no existe ${coreDb}`);
  console.warn(`[backup] aviso: no existe ${coreDb}`);
}

// --- almacén de autenticación ---------------------------------------------
// Estos ficheros no se regeneran: perder session.key echa a todo el mundo, y perder users.json
// se lleva las passkeys por delante.
for (const name of ['users.json', 'session.key', 'internal.key', 'revoked-sessions.json', 'audit.log']) {
  const source = join(authDir, name);
  if (!existsSync(source)) {
    manifest.warnings.push(`no existe ${source}`);
    continue;
  }
  const target = join(outDir, name);
  copyFileSync(source, target);
  record('auth', target);
}
console.log(`[backup] almacén de autenticación copiado (${manifest.files.filter((f) => f.label === 'auth').length} ficheros)`);

writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(`[backup] listo en ${outDir}`);
if (manifest.warnings.length) console.warn(`[backup] avisos:\n  ${manifest.warnings.join('\n  ')}`);
