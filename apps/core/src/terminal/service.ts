/**
 * Terminales interactivas.
 *
 * Otro contrato distinto al de los runs: la tmux remota es la continuidad, el WebSocket es
 * transporte efímero. Desconectar el socket nunca mata la sesión, y destruirla exige un comando
 * explícito. Sólo se pueden tocar sesiones con el prefijo de Jarvis.
 *
 * Contrato TERM-TMUX-01.
 */
import type { PermissionProfile, Provider, TerminalSession, UserIdentity } from '@jarvis/contracts';
import { JarvisError } from '@jarvis/contracts';
import {
  assertOurs, capturePaneCommand, getAdapter, hasSessionCommand, killSessionCommand,
  listSessionsCommand, newSessionCommand, parseSessionList, sessionName, sshExec,
  TmuxError, type CapabilityCache, type SshConfig,
} from '@jarvis/agent-adapters';
import type { Clock } from '../platform/clock.js';
import type { AuditLog } from '../platform/audit.js';

export interface TerminalServiceDeps {
  sshConfig: SshConfig;
  clock: Clock;
  audit: AuditLog;
  capabilities: CapabilityCache;
  bastionHost: string;
  /** La allowlist, para saber a quién preguntar al contar terminales. */
  hosts?: readonly string[];
}

export interface OpenTerminalCount {
  open: number;
  byHost: Array<{ host: string; open: number }>;
  at: string | null;
  /** El dato es el último conocido y ya venció; se está refrescando por detrás. */
  stale: boolean;
}

export class TerminalService {
  readonly #deps: TerminalServiceDeps;
  #count: OpenTerminalCount = { open: 0, byHost: [], at: null, stale: true };
  #counting: Promise<void> | null = null;

  constructor(deps: TerminalServiceDeps) {
    this.#deps = deps;
  }

  /**
   * Cuántas terminales vivas hay, para el aviso de la navegación.
   *
   * Contarlas cuesta un ssh por máquina, así que nunca se hace dentro de la petición: se devuelve
   * lo último que se supo y, si ya venció, se dispara el recuento por detrás. Una consola que se
   * queda esperando a seis servidores para pintar un número es peor que un número de hace un
   * minuto —y esto es un contador, no un dato con el que se decida nada—.
   *
   * Sólo se pregunta a los hosts que ya se sabían alcanzables y con tmux: uno caído no puede hacer
   * que el resto de la cuenta tarde su timeout entero.
   */
  openCount({ ttlMs = 60_000 }: { ttlMs?: number } = {}): OpenTerminalCount {
    const age = this.#count.at ? this.#deps.clock.nowMs() - Date.parse(this.#count.at) : Infinity;
    if (age > ttlMs && !this.#counting) {
      this.#counting = this.#refreshCount().finally(() => { this.#counting = null; });
    }
    return { ...this.#count, stale: age > ttlMs };
  }

  async #refreshCount(): Promise<void> {
    // `detect` sirve de la caché de capacidades (diez minutos), así que esto no es una ronda de
    // sondeos: es leer lo que ya se sabe y preguntar sólo por lo que caducó.
    const reachable: string[] = [];
    for (const host of this.#deps.hosts ?? []) {
      try {
        const known = await this.#deps.capabilities.detect(host);
        if (known.tmux) reachable.push(host);
      } catch {
        // Un host inalcanzable no tiene terminales que contar.
      }
    }
    const counted = await Promise.all(reachable.map(async (host) => {
      try {
        const sessions = await this.list(host);
        return { host, open: sessions.filter((session) => session.kind === 'interactive').length };
      } catch {
        // Una máquina que no responde no cuenta terminales, pero tampoco rompe el recuento.
        return { host, open: 0 };
      }
    }));
    this.#count = {
      open: counted.reduce((total, entry) => total + entry.open, 0),
      byHost: counted.filter((entry) => entry.open > 0),
      at: this.#deps.clock.nowIso(),
      stale: false,
    };
  }

  #exec(host: string, command: string, timeoutMs = 20_000) {
    return sshExec({ host, command, config: this.#deps.sshConfig }, { timeoutMs });
  }

  /** Las sesiones de run llevan su propio prefijo: distinguirlas evita matar trabajo por error. */
  async list(host: string): Promise<TerminalSession[]> {
    const result = await this.#exec(host, listSessionsCommand());
    return parseSessionList(result.stdout).map((session) => ({
      ...session,
      host,
      kind: session.name.startsWith('jarvis-run-') ? 'run' as const : 'interactive' as const,
    }));
  }

  /**
   * Prepara la sesión si no está, y dice cuál de las dos cosas pasó: el chat necesita saber si
   * acaba de retomar algo que ya estaba a medias.
   */
  async open({ host, provider, sessionId, cwd, permissionProfile = 'safe', user }: {
    host: string; provider: Provider; sessionId?: string | null; cwd?: string | null;
    permissionProfile?: PermissionProfile; user: UserIdentity;
  }): Promise<{ name: string; host: string; created: boolean }> {
    const capabilities = await this.#deps.capabilities.detect(host);
    if (!capabilities.tmux) {
      throw new JarvisError('TMUX_MISSING', `tmux is not installed on ${host}`, { scope: { host } });
    }
    if (!capabilities.binaries[provider]) {
      throw new JarvisError('PROVIDER_MISSING', `${provider} is not installed on ${host}`, { scope: { host, provider } });
    }

    const name = sessionName(`${provider}-${sessionId ?? 'new'}`);
    const exists = await this.#exec(host, hasSessionCommand(name));
    if (exists.code === 0) return { name, host, created: false };

    const adapter = getAdapter(provider);
    const { argv, env } = adapter.buildAttach({ sessionId: sessionId ?? null, permissionProfile });
    const result = await this.#exec(host, newSessionCommand({ name, argv, cwd: cwd ?? null, env }));
    if (result.code !== 0) {
      throw new JarvisError('HOST_UNREACHABLE', result.stderr.trim() || `tmux new-session failed (exit ${result.code})`, { scope: { host } });
    }

    this.#deps.audit.record({
      actorUser: user.username, eventType: 'terminal.opened', host,
      payload: { provider, sessionId: sessionId ?? null, permissionProfile, name },
    });
    return { name, host, created: true };
  }

  async capture({ host, name, lines }: { host: string; name: string; lines?: number }): Promise<string> {
    this.#assertOurs(name);
    const result = await this.#exec(host, capturePaneCommand({ name, ...(lines ? { lines } : {}) }));
    if (result.code !== 0) {
      throw new JarvisError('NOT_FOUND', result.stderr.trim() || 'the terminal session is not there', { scope: { host } });
    }
    return result.stdout;
  }

  /** Destruir una tmux es explícito y se audita: es la única forma de perder ese contexto. */
  async destroy({ host, name, user }: { host: string; name: string; user: UserIdentity }): Promise<void> {
    this.#assertOurs(name);
    const result = await this.#exec(host, killSessionCommand(name));
    if (result.code !== 0) {
      throw new JarvisError('NOT_FOUND', result.stderr.trim() || 'the terminal session is not there', { scope: { host } });
    }
    this.#deps.audit.record({ actorUser: user.username, eventType: 'terminal.destroyed', host, payload: { name } });
  }

  #assertOurs(name: string): void {
    try {
      assertOurs(name);
    } catch (error) {
      if (error instanceof TmuxError) throw new JarvisError('FORBIDDEN', error.message);
      throw error;
    }
  }
}
