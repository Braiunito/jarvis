/**
 * Lo que se puede mirar de un workspace sin lanzar un trabajo: ficheros adjuntos y cambios en el
 * directorio de trabajo (TEC-06).
 *
 * Hasta ahora el Assistant sólo veía texto —transcripts, salidas de agente, estados—, así que un
 * plan que dependiera de un fichero adjunto tenía que pedirle a un run que lo leyera: arrancar un
 * agente en otra máquina para mirar algo que ya estaba aquí, y esperar a que lo contara con sus
 * palabras.
 *
 * Dos reglas gobiernan este fichero:
 *
 *  1. **Sólo lectura, y acotada.** Nada de esto escribe, y todo dice cuánto se dejó fuera. Un
 *     modelo al que se le recorta la evidencia en silencio concluye sobre lo que no vio.
 *  2. **Lo que se lee es dato, nunca instrucciones.** El contenido de un fichero o de un diff lo
 *     escribió alguien que no es quien manda aquí, y puede llevar texto dirigido al modelo. Sale
 *     de aquí etiquetado con su procedencia para que quien lo consuma lo trate como lo que es.
 */
import { shellQuote, sshExec, sshFailureReason, type SshConfig } from '@jarvis/agent-adapters';
import { JarvisError } from '@jarvis/contracts';

/** Un trozo de fichero, con lo que hace falta para saber si se puede confiar en él. */
export interface FilePreview {
  path: string;
  host: string;
  bytes: number;
  text: string;
  truncated: boolean;
  /** Los binarios no se vuelcan: se dice qué son y cuánto ocupan. */
  binary: boolean;
  provenance: 'remote-file';
}

export interface WorkingChanges {
  host: string;
  cwd: string;
  /** `false` cuando ahí no hay repositorio: se dice, en vez de devolver una lista vacía. */
  isGitRepo: boolean;
  /** Fichero y estado, tal como los da `git status --porcelain`. */
  changed: Array<{ status: string; path: string }>;
  /** El resumen de `git diff --stat`, ya acotado. */
  summary: string | null;
  /** El diff de un fichero concreto, sólo si se pidió. */
  diff: { path: string; text: string; truncated: boolean } | null;
  truncated: boolean;
  provenance: 'remote-git';
}

export interface EvidenceServiceDeps {
  sshConfig: SshConfig;
  exec?: typeof sshExec;
  timeoutMs?: number;
}

/** Un path dentro de un comando remoto no puede empezar por guion: `git diff -x` es una opción. */
const looksLikeOption = (value: string): boolean => value.startsWith('-');

const NUL = '\u0000';

export class EvidenceService {
  readonly #deps: EvidenceServiceDeps;

  constructor(deps: EvidenceServiceDeps) {
    this.#deps = deps;
  }

  #exec(host: string, command: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const exec = this.#deps.exec ?? sshExec;
    return exec({ host, command, config: this.#deps.sshConfig }, { timeoutMs: this.#deps.timeoutMs ?? 20_000 });
  }

  /**
   * El principio de un fichero del host, con su tamaño real.
   *
   * El tamaño va en la primera línea y el contenido detrás: así una sola ida y vuelta dice a la vez
   * cuánto hay y qué se ha traído, y quien lo lee sabe si le falta algo.
   */
  async previewFile(
    { host, path, maxBytes = 4000 }: { host: string; path: string; maxBytes?: number },
  ): Promise<FilePreview> {
    if (looksLikeOption(path)) {
      throw new JarvisError('BAD_REQUEST', `ruta sospechosa: ${JSON.stringify(path)}`);
    }
    const quoted = shellQuote(path);
    const script = `if [ -f ${quoted} ]; then wc -c < ${quoted}; head -c ${Math.floor(maxBytes)} ${quoted};`
      + ' else echo MISSING; fi';
    const result = await this.#exec(host, `sh -c ${shellQuote(script)}`);
    if (result.code !== 0) {
      throw new JarvisError('HOST_UNREACHABLE', `no se pudo leer ${path} en ${host}: ${sshFailureReason(result)}`);
    }
    const newline = result.stdout.indexOf('\n');
    const head = newline === -1 ? result.stdout : result.stdout.slice(0, newline);
    if (head.trim() === 'MISSING') {
      throw new JarvisError('NOT_FOUND', `${path} no existe en ${host}`);
    }
    const bytes = Number.parseInt(head.trim(), 10);
    const body = newline === -1 ? '' : result.stdout.slice(newline + 1);
    // Un byte nulo no aparece en texto: es la señal más barata y más fiable de que esto no se lee.
    const binary = body.includes(NUL);
    return {
      path,
      host,
      bytes: Number.isFinite(bytes) ? bytes : body.length,
      text: binary ? '' : body,
      truncated: Number.isFinite(bytes) ? bytes > maxBytes : false,
      binary,
      provenance: 'remote-file',
    };
  }

  /**
   * Qué ha cambiado en el directorio de trabajo.
   *
   * Se pregunta con `git`, que es quien lo sabe, y se acepta que no haya repositorio: decirlo vale
   * más que devolver una lista vacía, que se lee como «no hay cambios».
   */
  async workingChanges(
    { host, cwd, path, maxFiles = 40, maxDiffChars = 4000 }:
    { host: string; cwd: string; path?: string | undefined; maxFiles?: number; maxDiffChars?: number },
  ): Promise<WorkingChanges> {
    if (path && looksLikeOption(path)) {
      throw new JarvisError('BAD_REQUEST', `ruta sospechosa: ${JSON.stringify(path)}`);
    }
    const dir = shellQuote(cwd);
    // El `--` cierra la lista de opciones: después de él, un path es un path y no un modificador.
    const diffPart = path
      ? ` printf '%s\\n' '<<<diff>>>'; git diff --no-color -- ${shellQuote(path)} | head -c ${Math.floor(maxDiffChars)};`
      : '';
    const script = `cd ${dir} 2>/dev/null || { echo NO_CWD; exit 0; };`
      + ' git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo NO_GIT; exit 0; };'
      + ` git status --porcelain=v1 | head -n ${Math.floor(maxFiles)};`
      + " printf '%s\\n' '<<<stat>>>';"
      + ' git diff --no-color --stat | tail -n 30;'
      + diffPart;
    const result = await this.#exec(host, `sh -c ${shellQuote(script)}`);
    if (result.code !== 0) {
      throw new JarvisError('HOST_UNREACHABLE',
        `no se pudieron mirar los cambios de ${cwd} en ${host}: ${sshFailureReason(result)}`);
    }
    return parseWorkingChanges(result.stdout, { host, cwd, path: path ?? null, maxFiles, maxDiffChars });
  }
}

/** Separado del transporte para poder probarlo con la salida real de git, sin máquina. */
export function parseWorkingChanges(
  stdout: string,
  { host, cwd, path, maxFiles, maxDiffChars }:
  { host: string; cwd: string; path: string | null; maxFiles: number; maxDiffChars: number },
): WorkingChanges {
  const base = {
    host,
    cwd,
    changed: [] as Array<{ status: string; path: string }>,
    summary: null,
    diff: null,
    truncated: false,
    provenance: 'remote-git' as const,
  };
  const trimmed = stdout.trim();
  if (trimmed === 'NO_CWD') {
    throw new JarvisError('NOT_FOUND', `${cwd} no existe en ${host}`);
  }
  if (trimmed === 'NO_GIT') return { ...base, isGitRepo: false };

  const [statusPart = '', rest = ''] = stdout.split('<<<stat>>>\n');
  const [statPart = '', diffPart] = rest.split('<<<diff>>>\n');

  const changed = statusPart.split('\n').filter((line) => line.trim()).map((line) => ({
    status: line.slice(0, 2).trim(),
    path: line.slice(3),
  }));

  return {
    ...base,
    isGitRepo: true,
    changed,
    summary: statPart.trim() || null,
    diff: path !== null
      ? {
        path,
        text: (diffPart ?? '').trim(),
        truncated: (diffPart ?? '').length >= maxDiffChars,
      }
      : null,
    // Una lista recortada se dice: si no, «40 ficheros» se lee como «todos los que hay».
    truncated: changed.length >= maxFiles,
  };
}
