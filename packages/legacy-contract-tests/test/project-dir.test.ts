/**
 * Contratos RESUME-CWD-01 y RESUME-HINT-01: encontrar dónde vive una conversación de Claude, y
 * decir la verdad cuando no se encuentra.
 *
 * El barrido se ejecuta **en un shell de verdad** contra directorios de verdad. Un comando remoto
 * que sólo se comprueba comparando cadenas es exactamente la clase de cosa que pasa el test y
 * falla en la máquina: ya nos ocurrió con el barrido de spools, cuyo comando no lo parseaba
 * ningún shell y aun así tenía su prueba en verde.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  buildCwdProbeScript, claudeProjectSlug, cwdCandidatesFromSlug, explainResumeFailure,
  parseCwdProbe,
} from '@jarvis/agent-adapters';

/**
 * La raíz falsa hace de «máquina», y su nombre es alfanumérico a propósito: un patrón viaja al
 * shell **sin comillas** —el glob es su razón de ser— y por eso el charset permitido es estrecho.
 * Un directorio temporal con guiones haría que el barrido descartara sus propios candidatos, que
 * es justo lo que debe hacer con una ruta que no controlamos.
 */
const ROOT = join(tmpdir(), `jarvisprojectdir${process.pid}`);
mkdirSync(ROOT, { recursive: true });
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function probe(patterns: string[], literals: string[] = []): string[] {
  const script = buildCwdProbeScript(
    patterns.map((pattern) => `${ROOT}${pattern}`),
    literals.map((literal) => `${ROOT}${literal}`),
  );
  if (!script) return [];
  const stdout = execFileSync('sh', ['-c', script], { encoding: 'utf8' });
  return parseCwdProbe(stdout).map((path) => path.slice(ROOT.length));
}

describe('RESUME-CWD-01 · el directorio se deduce del nombre del proyecto', () => {
  it('la raíz de pruebas es aceptable para el barrido, o el resto de este bloque no prueba nada', () => {
    expect(buildCwdProbeScript([`${ROOT}/x`])).toBeTruthy();
  });

  it('saca el slug del path del transcript, y sólo de un transcript', () => {
    expect(claudeProjectSlug('/root/.claude/projects/-var-www-vhosts-fmgagro-com/abc.jsonl'))
      .toBe('-var-www-vhosts-fmgagro-com');
    expect(claudeProjectSlug('/home/zeus/.claude/projects/-home-zeus/2db7ee7c.jsonl')).toBe('-home-zeus');
    expect(claudeProjectSlug('/root/.claude/statsig/cache.json')).toBeNull();
    expect(claudeProjectSlug(null)).toBeNull();
  });

  it('propone primero la lectura literal y después las que unen trozos', () => {
    const candidates = cwdCandidatesFromSlug('-var-www-vhosts-fmgagro-com');
    expect(candidates[0]).toBe('/var/www/vhosts/fmgagro/com');
    expect(candidates).toContain('/var/www/vhosts/fmgagro?com');
    // Un `?` no cruza barras, así que cada candidato tiene la profundidad que dice tener.
    expect(candidates.every((candidate) => candidate.startsWith('/'))).toBe(true);
  });

  it('un slug sin guiones intermedios es una sola carpeta', () => {
    expect(cwdCandidatesFromSlug('-root')).toEqual(['/root']);
  });

  it('lo que no es un slug de Claude no produce candidatos', () => {
    expect(cwdCandidatesFromSlug('var-www')).toEqual([]);      // no empieza en la raíz
    expect(cwdCandidatesFromSlug('-var-www-$(rm -rf /)')).toEqual([]);
    expect(cwdCandidatesFromSlug('')).toEqual([]);
    expect(cwdCandidatesFromSlug(null)).toEqual([]);
  });

  it('encuentra la carpeta real aunque el slug haya aplanado un punto', () => {
    mkdirSync(join(ROOT, 'var/www/vhosts/fmgagro.com'), { recursive: true });
    const found = probe(cwdCandidatesFromSlug('-var-www-vhosts-fmgagro-com'));
    expect(found).toEqual(['/var/www/vhosts/fmgagro.com']);
  });

  it('cuando la lectura literal existe, gana ella', () => {
    mkdirSync(join(ROOT, 'srv/app/data'), { recursive: true });
    const found = probe(cwdCandidatesFromSlug('-srv-app-data'));
    expect(found[0]).toBe('/srv/app/data');
  });

  it('un directorio que ya no existe no se devuelve, y ahí entra la deducción', () => {
    mkdirSync(join(ROOT, 'opt/mi-proyecto'), { recursive: true });
    // El índice decía otra cosa —ese directorio se borró—, así que gana lo que sí está.
    const found = probe(cwdCandidatesFromSlug('-opt-mi-proyecto'), ['/opt/borrado']);
    expect(found).toEqual(['/opt/mi-proyecto']);
  });

  it('sin ninguna coincidencia no inventa nada', () => {
    expect(probe(cwdCandidatesFromSlug('-no-existe-esto'))).toEqual([]);
  });

  it('el barrido lo parsea un shell de verdad, incluido zsh si está', () => {
    const script = buildCwdProbeScript(['/var/www/vhosts/fmgagro?com'], ['/srv/app']);
    expect(script).toBeTruthy();
    for (const shell of ['sh', 'bash', 'zsh']) {
      try {
        execFileSync(shell, ['-c', `${script as string}; exit 0`], { stdio: 'ignore' });
      } catch (error) {
        // Un shell que no está instalado no es un fallo del contrato.
        if ((error as { code?: string }).code !== 'ENOENT') {
          throw new Error(`${shell} no pudo ejecutar el barrido: ${(error as Error).message}`);
        }
      }
    }
  });

  it('sin candidatos no hay comando que ejecutar', () => {
    expect(buildCwdProbeScript([], [])).toBeNull();
  });
});

describe('RESUME-HINT-01 · el error dice que el problema es el directorio', () => {
  const base = { provider: 'claude', sessionId: 'd4e6f23c', workHost: 'vultr' };

  it('traduce el mensaje del CLI a lo que de verdad pasó', () => {
    const hint = explainResumeFailure({
      ...base, cwd: '/root', text: 'No conversation found with session ID: d4e6f23c',
    });
    expect(hint).toContain('/root');
    expect(hint).toContain('vultr');
    expect(hint).toContain('archivada en otra carpeta');
  });

  it('cuando no se sabía el directorio, lo dice en vez de callarlo', () => {
    const hint = explainResumeFailure({
      ...base, cwd: null, text: 'No conversation found with session ID: d4e6f23c',
    });
    expect(hint).toContain('sin decirle en qué directorio buscar');
  });

  it('cuando el directorio lo dedujimos del propio archivo, la carpeta no es el problema', () => {
    // Comprobado contra las máquinas: estas sesiones no se pueden reanudar («no conversation
    // found») ni estrenar con su id («already in use»). Decir «indica el directorio correcto»
    // aquí sería cambiar un mensaje engañoso por otro.
    const hint = explainResumeFailure({
      ...base, cwd: '/var/www/contaduria.braianmaciel.com', cwdSource: 'derived',
      text: 'No conversation found with session ID: d4e6f23c',
    });
    expect(hint).toContain('El directorio ya es el correcto');
    expect(hint).toContain('no guarda ningún turno');
    expect(hint).toContain('Empieza una sesión nueva');
    expect(hint).not.toContain('archivada en otra carpeta');
  });

  it('cualquier otro fallo se queda como estaba: no se disfraza de esto', () => {
    expect(explainResumeFailure({ ...base, cwd: '/root', text: 'credit balance too low' })).toBeNull();
    expect(explainResumeFailure({ ...base, cwd: '/root', text: null })).toBeNull();
  });
});
