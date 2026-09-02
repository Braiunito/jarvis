/**
 * TEC-11: una sesión de Claude cuyo directorio nadie sabe.
 *
 * Aquí se prueba la decisión —cuándo se pregunta, qué se acepta, qué se guarda— con la sonda
 * simulada. Que el comando que va a la máquina lo entienda un shell de verdad se prueba en
 * `packages/legacy-contract-tests/test/project-dir.test.ts`, que lo ejecuta.
 */
import { describe, expect, it } from 'vitest';
import { defaultSshConfig, type SshResult } from '@jarvis/agent-adapters';
import type { SessionRef } from '@jarvis/contracts';
import { CwdResolver } from '../src/sessions/cwd-resolver.js';

const config = defaultSshConfig({ hosts: ['vultr'], bastionHost: 'bastion' });
const ref: SessionRef = { host: 'vultr', provider: 'claude', sessionId: 'd4e6f23c' };
const transcript = '/root/.claude/projects/-var-www-contaduria-braianmaciel-com/d4e6f23c.jsonl';

function build({
  cwd = '', path = transcript, stdout = '', fail = false, locateFails = false,
}: { cwd?: string; path?: string; stdout?: string; fail?: boolean; locateFails?: boolean } = {}) {
  const calls: string[] = [];
  const resolver = new CwdResolver({
    sessions: {
      locate: async () => {
        calls.push('locate');
        if (locateFails) throw new Error('el índice no responde');
        return { path, cwd: cwd || null };
      },
    },
    sshConfig: config,
    exec: async ({ command }): Promise<SshResult> => {
      calls.push(command);
      if (fail) throw new Error('host caído');
      return { code: 0, stdout, stderr: '' };
    },
  });
  return { resolver, calls };
}

describe('TEC-11 · encontrar el directorio de una sesión', () => {
  it('deduce el directorio del nombre del proyecto y lo confirma en la máquina', async () => {
    const { resolver, calls } = build({ stdout: '/var/www/contaduria.braianmaciel.com\n' });
    const found = await resolver.resolve(ref);
    expect(found).toEqual({
      cwd: '/var/www/contaduria.braianmaciel.com', source: 'derived', alsoMatched: [],
    });
    // El comando va dentro de `sh -c`: el shell de login remoto suele ser zsh, y allí un glob sin
    // coincidencias aborta el barrido entero.
    expect(calls[1]).toMatch(/^sh -c /);
    expect(calls[1]).toContain('/var/www/contaduria/braianmaciel/com');
  });

  it('el directorio que declara el índice también se comprueba, y si está gana él', async () => {
    const { resolver, calls } = build({ cwd: '/var/www/vhosts/fmgagro.com', stdout: '/var/www/vhosts/fmgagro.com\n' });
    const found = await resolver.resolve(ref);
    expect(found?.source).toBe('index');
    expect(found?.cwd).toBe('/var/www/vhosts/fmgagro.com');
    // Se pregunta antes que las deducciones: si el directorio que el índice declaraba sigue ahí,
    // no hay nada que deducir.
    const script = calls[1] as string;
    expect(script.indexOf('fmgagro.com')).toBeLessThan(script.indexOf('?'));
  });

  it('la ruta del índice pasa por el entrecomillado, no por el glob', async () => {
    // Un directorio con un espacio es lo que separa «ruta conocida» de «patrón»: sin comillas, el
    // `for` lo partiría en dos palabras y comprobaría dos directorios que no existen.
    const { resolver, calls } = build({ cwd: '/srv/mi proyecto', stdout: '/srv/mi proyecto\n' });
    expect((await resolver.resolve(ref))?.cwd).toBe('/srv/mi proyecto');
    expect(calls[1]).toContain('mi proyecto');
    expect(calls[1]).not.toContain('in /srv/mi proyecto ');
  });

  it('un directorio del índice que ya no existe deja paso a la deducción', async () => {
    const { resolver } = build({ cwd: '/var/www/borrado', stdout: '/var/www/contaduria.braianmaciel.com\n' });
    const found = await resolver.resolve(ref);
    expect(found).toEqual({
      cwd: '/var/www/contaduria.braianmaciel.com', source: 'derived', alsoMatched: [],
    });
  });

  it('cuando hay más de una lectura posible se queda con la primera y anota el resto', async () => {
    const { resolver } = build({ stdout: '/var/www/contaduria/braianmaciel/com\n/var/www/contaduria.braianmaciel.com\n' });
    const found = await resolver.resolve(ref);
    expect(found?.cwd).toBe('/var/www/contaduria/braianmaciel/com');
    expect(found?.alsoMatched).toEqual(['/var/www/contaduria.braianmaciel.com']);
  });

  it('sin ninguna coincidencia no inventa un directorio', async () => {
    const { resolver } = build({ stdout: '' });
    expect(await resolver.resolve(ref)).toBeNull();
  });

  it('no pregunta dos veces por la misma sesión', async () => {
    const { resolver, calls } = build({ stdout: '/var/www/contaduria.braianmaciel.com\n' });
    await resolver.resolve(ref);
    await resolver.resolve(ref);
    expect(calls.filter((call) => call === 'locate')).toHaveLength(1);
  });

  it('sólo Claude archiva por directorio: a los otros ni se les pregunta', async () => {
    const { resolver, calls } = build();
    expect(await resolver.resolve({ ...ref, provider: 'codex' })).toBeNull();
    expect(calls).toEqual([]);
  });

  it('un host caído o un índice mudo no rompen nada: se devuelve «no lo sé»', async () => {
    const caido = build({ fail: true });
    expect(await caido.resolver.resolve(ref)).toBeNull();
    const mudo = build({ locateFails: true });
    expect(await mudo.resolver.resolve(ref)).toBeNull();
  });

  it('un path que no es un transcript de proyecto no produce sonda', async () => {
    const { resolver, calls } = build({ path: '/root/.claude/history.jsonl' });
    expect(await resolver.resolve(ref)).toBeNull();
    expect(calls).toEqual(['locate']);
  });
});
