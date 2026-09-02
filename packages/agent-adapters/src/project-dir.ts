/**
 * Dónde guardó Claude Code una conversación, cuando el índice no lo sabe.
 *
 * Claude Code archiva por directorio de trabajo: `~/.claude/projects/<slug>/<uuid>.jsonl`, donde
 * el slug es el path del cwd con **cada carácter no alfanumérico convertido en un guion**. Ese
 * aplanado pierde información —`/var/www/vhosts/fmgagro.com` y `/var/www/vhosts/fmgagro/com`
 * producen el mismo slug— así que el path no se puede invertir a ciegas: hay que preguntarle a la
 * máquina cuál de las lecturas posibles existe de verdad.
 *
 * Por qué importa: `claude --resume <id>` lanzado desde otro directorio responde «No conversation
 * found with session ID», que suena a sesión borrada cuando lo único que pasa es que se está
 * mirando en la carpeta equivocada. El transcript lleva el cwd dentro, pero sólo en las líneas de
 * mensaje: una sesión sin turnos —diez había en la flota— no lo lleva en ninguna, y ahí el nombre
 * del directorio es la única pista que queda.
 *
 * Contratos: RESUME-CWD-01, RESUME-HINT-01.
 */
import { shellQuote } from './ssh.js';

/** Un candidato sólo puede llevar esto: se emite sin comillas para que el shell expanda el glob. */
const CANDIDATE_SAFE = /^[A-Za-z0-9/?]+$/;

/** El slug del directorio de proyecto, sacado del path del transcript. */
export function claudeProjectSlug(transcriptPath: string | null | undefined): string | null {
  if (!transcriptPath) return null;
  const match = /\/projects\/([^/]+)\/[^/]+\.jsonl$/.exec(String(transcriptPath));
  return match?.[1] ?? null;
}

/**
 * Las lecturas posibles de un slug, de la más literal a la menos.
 *
 * Cada guion fue un carácter cualquiera que no era alfanumérico, así que cada uno puede volver a
 * ser una barra —el caso normal— o cualquier otro carácter, que en un glob se escribe `?`. Se
 * ordenan por número de `?`: primero la lectura con todas las barras, que es la correcta salvo
 * que el nombre llevara un punto, un guion o un espacio.
 *
 * El primer guion siempre es la barra de la raíz: un slug de Claude empieza por ella.
 */
export function cwdCandidatesFromSlug(slug: string | null | undefined, limit = 64): string[] {
  if (!slug || !slug.startsWith('-')) return [];
  const body = slug.slice(1);
  if (!body || !/^[A-Za-z0-9-]+$/.test(body)) return [];

  const holes: number[] = [];
  for (let i = 0; i < body.length; i += 1) if (body[i] === '-') holes.push(i);
  if (holes.length === 0) return [`/${body}`];

  const chars = [...body];
  const render = (wildcards: readonly number[]): string => {
    const out = [...chars];
    for (const index of holes) out[index] = wildcards.includes(index) ? '?' : '/';
    return `/${out.join('')}`;
  };

  const found: string[] = [];
  // Por número de comodines: cero primero, y de ahí subiendo hasta llenar el presupuesto.
  for (let k = 0; k <= holes.length && found.length < limit; k += 1) {
    const pick = (start: number, chosen: number[]): void => {
      if (found.length >= limit) return;
      if (chosen.length === k) { found.push(render(chosen)); return; }
      for (let i = start; i < holes.length; i += 1) {
        pick(i + 1, [...chosen, holes[i] as number]);
        if (found.length >= limit) return;
      }
    };
    pick(0, []);
  }
  return found;
}

/**
 * El comando que decide cuáles de las rutas candidatas existen en la máquina.
 *
 * Dos clases de candidato, y la diferencia importa:
 *
 *   - `literal` es una ruta que ya conocemos —la que declaraba el transcript— y va entrecomillada,
 *     porque puede llevar puntos, espacios o cualquier cosa y no queremos que el shell la
 *     interprete. Va primero: comprobar que sigue existiendo evita lanzar un trabajo contra un
 *     directorio que se borró hace tres meses, que muere con un `cd` fallido y un código 2.
 *   - `patterns` son las lecturas posibles del slug, con `?` donde había un carácter cualquiera.
 *     Van sin comillas porque el glob es justamente lo que hace el trabajo.
 *
 * Todo va dentro de `sh -c` a propósito: el shell de login de estas máquinas suele ser zsh, donde
 * un glob sin coincidencias **aborta el comando** en vez de quedarse literal, y eso convertiría la
 * primera ruta inexistente en el final del barrido.
 */
export function buildCwdProbeScript(
  patterns: readonly string[],
  literals: readonly string[] = [],
): string | null {
  const safe = patterns.filter((candidate) => CANDIDATE_SAFE.test(candidate));
  const quoted = literals.filter(Boolean).map((literal) => shellQuote(literal));
  const all = [...quoted, ...safe];
  if (!all.length) return null;
  return `for p in ${all.join(' ')}; do [ -d "$p" ] && printf '%s\\n' "$p"; done 2>/dev/null | head -n 5`;
}

/** Las rutas que la sonda confirmó, en el orden en que se preguntaron. */
export function parseCwdProbe(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('/'));
}

export interface ResumeHintInput {
  provider: string;
  /** Lo que dijo el agente: el texto del resultado o sus `errors`. */
  text: string | null | undefined;
  sessionId: string | null | undefined;
  cwd: string | null | undefined;
  workHost: string | null | undefined;
}

/**
 * Traduce «no encuentro esa conversación» a lo que de verdad ocurrió.
 *
 * El mensaje del CLI es correcto desde su punto de vista —en ese directorio no está— y engañoso
 * desde el de quien lo lee, que ve la sesión listada en Jarvis y deduce que algo se ha perdido.
 */
export function explainResumeFailure({ provider, text, sessionId, cwd, workHost }: ResumeHintInput): string | null {
  const message = String(text ?? '');
  if (!/no conversation found with session id/i.test(message)) return null;
  const where = cwd
    ? `se ejecutó en ${cwd}`
    : 'se ejecutó sin decirle en qué directorio buscar, así que miró en el directorio por defecto';
  const machine = workHost ? ` de ${workHost}` : '';
  return `${provider} guarda cada conversación bajo el directorio en el que se abrió, y ésta ${where}${machine}: `
    + `la sesión ${sessionId ?? ''} existe, pero está archivada en otra carpeta. `
    + 'Indica el directorio correcto en el workspace y el trabajo podrá continuarla.';
}
