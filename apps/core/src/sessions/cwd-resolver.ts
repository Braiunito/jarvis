/**
 * Encontrar el directorio donde vive una conversación cuando el índice no lo sabe (TEC-11).
 *
 * `claude --resume <id>` sólo ve las conversaciones del directorio desde el que se lanza. Si el
 * workspace no tiene `cwd`, el trabajo arranca en el directorio por defecto y el CLI responde «No
 * conversation found with session ID», que se lee como «la sesión ya no existe». Existe: está
 * archivada en otra carpeta.
 *
 * De dónde sale el dato, en este orden:
 *
 *   1. El propio índice, si lo trae. Es lo que declaraba el transcript y no hay nada mejor.
 *   2. El nombre del directorio de proyecto, confirmado contra la máquina. Claude aplana el path
 *      a un slug, así que hay varias lecturas posibles y sólo el host puede decir cuál existe.
 *
 * Nunca lanza: esto es una mejora oportunista dentro del camino de crear un trabajo, y un índice
 * lento o un host caído no pueden convertirse en «no se puede lanzar nada».
 */
import type { SessionRef } from '@jarvis/contracts';
import {
  buildCwdProbeScript, claudeProjectSlug, cwdCandidatesFromSlug, parseCwdProbe,
  shellQuote, sshExec, type SshConfig,
} from '@jarvis/agent-adapters';

export interface ResolvedCwd {
  cwd: string;
  source: 'index' | 'derived';
  /** Las otras rutas que también existían. Se registran: una deducción ambigua conviene verla. */
  alsoMatched: string[];
}

type Exec = typeof sshExec;

export interface CwdResolverDeps {
  sessions: { locate(ref: SessionRef): Promise<{ path: string; cwd: string | null } | null> };
  sshConfig: SshConfig;
  exec?: Exec;
  timeoutMs?: number;
  ttlMs?: number;
  now?: () => number;
  onWarn?: (message: string) => void;
}

export class CwdResolver {
  readonly #deps: CwdResolverDeps;
  readonly #cache = new Map<string, { at: number; value: ResolvedCwd | null }>();

  constructor(deps: CwdResolverDeps) {
    this.#deps = deps;
  }

  #now(): number { return (this.#deps.now ?? Date.now)(); }

  async resolve(ref: SessionRef): Promise<ResolvedCwd | null> {
    // Sólo Claude archiva por directorio; los otros dos guardan la sesión en un único store.
    if (ref.provider !== 'claude') return null;

    const key = `${ref.host}|${ref.sessionId}`;
    const cached = this.#cache.get(key);
    const ttl = this.#deps.ttlMs ?? 10 * 60 * 1000;
    if (cached && this.#now() - cached.at < ttl) return cached.value;

    const value = await this.#resolveUncached(ref);
    this.#cache.set(key, { at: this.#now(), value });
    return value;
  }

  async #resolveUncached(ref: SessionRef): Promise<ResolvedCwd | null> {
    let located: { path: string; cwd: string | null } | null = null;
    try {
      located = await this.#deps.sessions.locate(ref);
    } catch (error) {
      this.#warn(`no se pudo consultar el índice para ${ref.sessionId}: ${(error as Error).message}`);
      return null;
    }
    if (!located) return null;

    /**
     * También se comprueba el directorio que declara el índice, no sólo los deducidos.
     *
     * Un `cwd` que el transcript declaraba pero que ya no existe —el proyecto se movió o se
     * borró— hace que el trabajo muera con un `cd` fallido y un código de salida 2, sin nada que
     * explique nada. Comprobarlo en la misma llamada no cuesta una ida y vuelta más y deja
     * elegir: si sigue ahí, se usa; si no, gana la deducción, que sí existe.
     */
    const candidates = cwdCandidatesFromSlug(claudeProjectSlug(located.path));
    const script = buildCwdProbeScript(candidates, located.cwd ? [located.cwd] : []);
    if (!script) return null;

    try {
      // Dentro de `sh -c` porque el shell de login remoto suele ser zsh, donde un glob sin
      // coincidencias aborta el comando entero en vez de quedarse literal.
      const exec = this.#deps.exec ?? sshExec;
      const result = await exec(
        { host: ref.host, command: `sh -c ${shellQuote(script)}`, config: this.#deps.sshConfig },
        { timeoutMs: this.#deps.timeoutMs ?? 15_000 },
      );
      const matches = parseCwdProbe(result.stdout);
      const [first, ...rest] = matches;
      if (!first) return null;
      return { cwd: first, source: first === located.cwd ? 'index' : 'derived', alsoMatched: rest };
    } catch (error) {
      this.#warn(`no se pudo comprobar el directorio de ${ref.sessionId} en ${ref.host}: ${(error as Error).message}`);
      return null;
    }
  }

  #warn(message: string): void {
    this.#deps.onWarn?.(message);
  }
}
