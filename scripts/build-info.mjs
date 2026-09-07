#!/usr/bin/env node
/**
 * Qué se está construyendo, exactamente.
 *
 * Estaba **declarado en `package.json` y no existía**: `npm run build:info` fallaba desde vaya
 * usted a saber cuándo, y nadie lo llamaba. Su contenido acabó copiado dentro de `ci.yml` como un
 * `node -e` de cuatro líneas, así que la declaración se quedó apuntando al vacío. Un guion que se
 * anuncia y no está es la misma forma de fallo que llevamos el día cazando, sólo que en el
 * `package.json`.
 *
 * Lo que emite es lo que hace falta para responder «¿lo que corre es lo que creo?»: el commit, si
 * el árbol tenía cambios sin comitear al construir, y las versiones que deciden si un binario vale
 * en otra máquina. Sale por la salida estándar y no escribe nada: quien lo quiera en un fichero lo
 * redirige, que es lo que hace CI.
 *
 * `dirty: true` importa más de lo que parece con varias sesiones sobre el mismo árbol: significa
 * que lo construido **no es ningún commit**, así que no se puede volver a él.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const git = (...args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    // Sin git —dentro de un contenedor de construcción, por ejemplo— se dice que no se sabe en vez
    // de inventar un valor. `null` es una respuesta; `'unknown'` es una cadena que alguien compara.
    return null;
  }
};

const require = createRequire(import.meta.url);
const sqlite = () => {
  try {
    const db = new (require('better-sqlite3'))(':memory:');
    return db.prepare('select sqlite_version() v').get().v;
  } catch {
    return null;
  }
};

const info = {
  commit: git('rev-parse', 'HEAD'),
  shortCommit: git('rev-parse', '--short', 'HEAD'),
  branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
  /** Si había cambios sin comitear: entonces esto no es ningún commit y no se puede reproducir. */
  dirty: git('status', '--porcelain') !== null ? git('status', '--porcelain') !== '' : null,
  builtAt: new Date().toISOString(),
  node: process.version,
  sqlite: sqlite(),
};

process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
