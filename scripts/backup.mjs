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
 *
 * Las dos mitades no viven en el mismo sitio: la base la monta el core y el almacén de
 * autenticación lo monta el gateway, y ningún contenedor ve las dos —esa separación es la
 * frontera de privilegio del ADR-001 y no se toca para hacer una copia—. Por eso `--only` deja
 * hacer media copia en cada uno, cada una con su manifiesto, y `restore.mjs` sabe juntarlas.
 */
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

/**
 * Qué mitad se copia: `core` la base, `auth` el almacén del gateway, `all` las dos.
 *
 * Cada mitad escribe su propio manifiesto —`manifest-core.json`, `manifest-auth.json`— para que
 * las dos puedan aterrizar en el mismo directorio sin pisarse. Una copia completa hecha de una
 * vez sigue escribiendo `manifest.json`, como siempre.
 */
const only = args.get('only') ?? 'all';
if (!['all', 'core', 'auth'].includes(only)) {
  console.error(`[backup] --only=${only} no existe; usa core, auth o all`);
  process.exit(2);
}
const manifestName = args.get('manifest') ?? (only === 'all' ? 'manifest.json' : `manifest-${only}.json`);

mkdirSync(outDir, { recursive: true });
const manifest = { createdAt: new Date().toISOString(), files: [], warnings: [] };

const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

const record = (label, path) => {
  manifest.files.push({ label, name: basename(path), bytes: statSync(path).size, sha256: digest(path) });
};

// --- base del core ---------------------------------------------------------
// `better-sqlite3` se carga sólo si de verdad se va a tocar la base: la imagen del gateway
// instala sus dependencias de ejecución de cero y no tiene por qué llevarla, y un `import` arriba
// del todo haría fallar ahí una copia que no necesita SQLite para nada.
if (only !== 'auth' && existsSync(coreDb)) {
  const { default: Database } = await import('better-sqlite3');
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
} else if (only !== 'auth') {
  manifest.warnings.push(`no existe ${coreDb}`);
  console.warn(`[backup] aviso: no existe ${coreDb}`);
}

// --- almacén de autenticación ---------------------------------------------
// Estos ficheros no se regeneran: perder session.key echa a todo el mundo, y perder users.json
// se lleva las passkeys por delante.
for (const name of only === 'core' ? [] : ['users.json', 'session.key', 'internal.key', 'revoked-sessions.json', 'audit.log']) {
  const source = join(authDir, name);
  if (!existsSync(source)) {
    manifest.warnings.push(`no existe ${source}`);
    continue;
  }
  const target = join(outDir, name);
  copyFileSync(source, target);
  record('auth', target);
}
if (only !== 'core') {
  console.log(`[backup] almacén de autenticación copiado (${manifest.files.filter((f) => f.label === 'auth').length} ficheros)`);
}

writeFileSync(join(outDir, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(`[backup] listo en ${outDir}`);
if (manifest.warnings.length) console.warn(`[backup] avisos:\n  ${manifest.warnings.join('\n  ')}`);
