/**
 * La copia de seguridad, ejecutada de verdad.
 *
 * No había ninguna prueba de esto, y el resultado fue que `bin/jarvis backup` llevaba desde
 * siempre sin funcionar contra el stack desplegado sin que nadie se enterara hasta necesitarlo a
 * las once de la noche. Así que aquí los scripts **se ejecutan como procesos**, con ficheros de
 * verdad en disco, y se comprueba lo que dejan.
 *
 * Lo que no se puede probar aquí es el `docker cp` de `bin/jarvis`, que necesita un stack vivo.
 * Lo que sí se prueba es lo que hacía imposible arreglarlo: que cada mitad se pueda copiar por
 * separado —la base la monta el core, la autenticación el gateway, y ningún contenedor ve las
 * dos— y que el restore sepa juntarlas.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../../apps/core/src/platform/db.js';

const REPO = new URL('../..', import.meta.url).pathname;
let work: string;

/**
 * Se juntan las dos salidas a propósito: los avisos van por `stderr` —«esta copia no trae el
 * almacén de autenticación» es uno de ellos— y mirar sólo `stdout` haría pasar un test que no
 * comprueba justo lo que importa.
 */
const runFails = (script: string, args: string[]): { status: number; output: string } => {
  const result = spawnSync('node', [join(REPO, 'scripts', script), ...args], { encoding: 'utf8' });
  return { status: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
};

const run = (script: string, args: string[]): string => {
  const { status, output } = runFails(script, args);
  if (status !== 0) throw new Error(`${script} falló con ${status}:\n${output}`);
  return output;
};

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'jarvis-backup-'));
  // La mitad del core: una base real y migrada. Sin migrar no vale para esto: el restore cuenta
  // workspaces, runs y eventos para decir qué ha recuperado, y sobre una base vacía eso revienta.
  const db = openDatabase({ path: join(work, 'core', 'core.db') });
  migrate(db);
  db.close();
  // La mitad del gateway: lo que no se regenera nunca.
  mkdirSync(join(work, 'auth'), { recursive: true });
  writeFileSync(join(work, 'auth', 'users.json'), '{"version":1,"users":[]}');
  writeFileSync(join(work, 'auth', 'session.key'), 'clave-de-sesión-de-mentira');
  writeFileSync(join(work, 'auth', 'internal.key'), 'clave-interna-de-mentira');
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

const backupCore = (out: string): string =>
  run('backup.mjs', [`--only=core`, `--core-db=${join(work, 'core', 'core.db')}`, `--out=${out}`]);
const backupAuth = (out: string): string =>
  run('backup.mjs', [`--only=auth`, `--auth-dir=${join(work, 'auth')}`, `--out=${out}`]);

describe('una copia en dos mitades, que es como la hace el stack desplegado', () => {
  it('cada contenedor copia la suya en el mismo sitio y no se pisan', () => {
    const out = join(work, 'copia');
    backupCore(out);
    backupAuth(out);

    expect(existsSync(join(out, 'core.db'))).toBe(true);
    expect(existsSync(join(out, 'users.json'))).toBe(true);
    expect(existsSync(join(out, 'session.key'))).toBe(true);
    // Dos manifiestos, uno por mitad: es lo que les permite aterrizar juntos.
    expect(existsSync(join(out, 'manifest-core.json'))).toBe(true);
    expect(existsSync(join(out, 'manifest-auth.json'))).toBe(true);

    const core = JSON.parse(readFileSync(join(out, 'manifest-core.json'), 'utf8'));
    expect(core.files.map((f: { label: string }) => f.label)).toEqual(['core-db']);
    const auth = JSON.parse(readFileSync(join(out, 'manifest-auth.json'), 'utf8'));
    expect(auth.files.every((f: { label: string }) => f.label === 'auth')).toBe(true);
  });

  it('la mitad de autenticación no necesita SQLite: se copia donde no hay base', () => {
    // Es lo que permite que corra dentro del gateway, cuya imagen instala sus dependencias de
    // ejecución de cero y no tiene por qué llevar better-sqlite3.
    const out = join(work, 'solo-auth');
    const salida = run('backup.mjs', [`--only=auth`, `--core-db=${join(work, 'no-existe.db')}`,
      `--auth-dir=${join(work, 'auth')}`, `--out=${out}`]);
    expect(salida).toContain('almacén de autenticación copiado');
    expect(existsSync(join(out, 'core.db'))).toBe(false);
  });

  it('el restore junta las dos mitades y las verifica', () => {
    const out = join(work, 'copia');
    backupCore(out);
    backupAuth(out);

    const salida = run('restore.mjs', [`--from=${out}`,
      `--core-db=${join(work, 'restaurado', 'core.db')}`, `--auth-dir=${join(work, 'restaurado')}`]);

    expect(salida).toContain('copia en 2 mitades');
    expect(salida).toContain('integrity_check ok');
    expect(existsSync(join(work, 'restaurado', 'core.db'))).toBe(true);
    expect(existsSync(join(work, 'restaurado', 'users.json'))).toBe(true);
    expect(existsSync(join(work, 'restaurado', 'session.key'))).toBe(true);
  });

  it('una copia entera de una sola vez sigue funcionando como siempre', () => {
    const out = join(work, 'entera');
    run('backup.mjs', [`--core-db=${join(work, 'core', 'core.db')}`,
      `--auth-dir=${join(work, 'auth')}`, `--out=${out}`]);
    expect(existsSync(join(out, 'manifest.json'))).toBe(true);

    const salida = run('restore.mjs', [`--from=${out}`,
      `--core-db=${join(work, 'r2', 'core.db')}`, `--auth-dir=${join(work, 'r2')}`]);
    expect(salida).toContain('integrity_check ok');
    expect(salida).not.toContain('AVISO');
  });
});

describe('lo que no puede pasar en silencio', () => {
  it('media copia se restaura, pero lo dice', () => {
    const out = join(work, 'solo-core');
    backupCore(out);
    const salida = run('restore.mjs', [`--from=${out}`,
      `--core-db=${join(work, 'r3', 'core.db')}`, `--auth-dir=${join(work, 'r3')}`]);
    expect(salida).toContain('no trae el almacén de autenticación');
  });

  it('un fichero cambiado después de la copia se detecta por su checksum', () => {
    const out = join(work, 'copia');
    backupCore(out);
    backupAuth(out);
    writeFileSync(join(out, 'users.json'), '{"version":1,"users":["colado"]}');

    const { status, output } = runFails('restore.mjs', [`--from=${out}`,
      `--core-db=${join(work, 'r4', 'core.db')}`, `--auth-dir=${join(work, 'r4')}`]);
    expect(status).toBe(1);
    expect(output).toContain('no coincide con su checksum');
  });

  it('un directorio sin manifiesto no se restaura a medias: se explica qué falta', () => {
    const { status, output } = runFails('restore.mjs', [`--from=${work}`]);
    expect(status).toBe(2);
    expect(output).toContain('manifest-core.json');
  });

  it('un --only inventado se rechaza en vez de copiar media cosa', () => {
    const { status, output } = runFails('backup.mjs', [`--only=medio`, `--out=${join(work, 'x')}`]);
    expect(status).toBe(2);
    expect(output).toContain('usa core, auth o all');
  });
});
