/**
 * Dónde corre de verdad una tarea.
 *
 *   B (preferida) — el CLI del agente existe en el target, así que el agente corre allí, junto
 *                   al código.
 *   A (fallback)  — el target no tiene el CLI, así que el agente corre en el bastión y llega al
 *                   target por SSH. Al prompt se le dice explícitamente, porque un agente que
 *                   cree estar en la máquina equivocada lee y edita los ficheros equivocados.
 *
 * Contratos: HOST-CAP-01, HOST-TARGET-01, HOST-PREAMBLE-01, HOST-SSHFAIL-01.
 */
import type { HostCapabilities, PermissionProfile, Provider, Strategy, TargetPlan } from '@jarvis/contracts';
import { remotePathExport, shellJoin, sshExec, sshFailureReason, type SshConfig } from './ssh.js';

const PROBE_BINARIES = ['claude', 'codex', 'opencode', 'tmux', 'git', 'python3'] as const;

export interface CapabilityStoreEntry {
  at: number;
  capabilities: HostCapabilities;
}

export interface CapabilityProbeOptions {
  config: SshConfig;
  ttlMs?: number;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * Caché de capacidades por host.
 *
 * Cachear evita una ida y vuelta por cada decisión; conservar el último resultado bueno evita
 * que una sonda fallida convierta una pantalla útil en una vacía (`stale: true` lo dice).
 */
export class CapabilityCache {
  readonly #entries = new Map<string, CapabilityStoreEntry>();
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #config: SshConfig;

  constructor({ config, ttlMs = 10 * 60 * 1000, now = Date.now, timeoutMs = 20_000 }: CapabilityProbeOptions) {
    this.#config = config;
    this.#ttlMs = ttlMs;
    this.#now = now;
    this.#timeoutMs = timeoutMs;
  }

  forget(host?: string): void {
    if (host) this.#entries.delete(host);
    else this.#entries.clear();
  }

  lastKnown(host: string): HostCapabilities | null {
    return this.#entries.get(host)?.capabilities ?? null;
  }

  async detect(host: string, { force = false }: { force?: boolean } = {}): Promise<HostCapabilities> {
    const cached = this.#entries.get(host);
    if (!force && cached && this.#now() - cached.at < this.#ttlMs) return cached.capabilities;

    // `command -v` por binario, cada uno en su línea, para que una herramienta ausente no aborte
    // la sonda. El prefijo PATH importa: sin él, un Codex en ~/.local/bin es invisible por ssh.
    const script = remotePathExport(this.#config.remotePath) + [
      ...PROBE_BINARIES.map((binary) =>
        `printf '%s\\t%s\\n' ${shellJoin([binary])} "$(command -v ${shellJoin([binary])} || echo -)"`),
      // El home del usuario remoto, para poder resolver un spool configurado como `$HOME/...`.
      `printf '%s\\t%s\\n' ${shellJoin(['@home'])} "$HOME"`,
    ].join('; ');

    const result = await sshExec(
      { host, command: script, config: this.#config },
      { timeoutMs: this.#timeoutMs },
    );

    if (result.code !== 0) {
      throw new HostUnreachableError(host, sshFailureReason(result));
    }

    const binaries: Record<string, string | null> = {};
    let home: string | null = null;
    for (const line of result.stdout.split('\n')) {
      const [name, path] = line.split('\t');
      if (!name || !name.trim()) continue;
      const value = path && path.trim() !== '-' ? path.trim() : null;
      if (name.trim() === '@home') home = value;
      else binaries[name.trim()] = value;
    }
    const capabilities: HostCapabilities = {
      host,
      reachable: true,
      binaries,
      providers: (['claude', 'codex', 'opencode'] as Provider[]).filter((p) => binaries[p]),
      tmux: Boolean(binaries['tmux']),
      home,
      probedAt: new Date(this.#now()).toISOString(),
    };
    this.#entries.set(host, { at: this.#now(), capabilities });
    return capabilities;
  }
}

export class HostUnreachableError extends Error {
  override name = 'HostUnreachableError';
  readonly host: string;
  constructor(host: string, reason: string) {
    super(`cannot reach ${host}: ${reason}`);
    this.host = host;
  }
}

export class TargetImpossibleError extends Error {
  override name = 'TargetImpossibleError';
  readonly code: 'PROVIDER_MISSING' | 'STRATEGY_IMPOSSIBLE';
  constructor(code: 'PROVIDER_MISSING' | 'STRATEGY_IMPOSSIBLE', message: string) {
    super(message);
    this.code = code;
  }
}

export interface ResolveTargetOptions {
  sessionHost: string | null | undefined;
  provider: Provider;
  permissionProfile: PermissionProfile;
  cwd?: string | null;
  preferred?: 'auto' | 'A' | 'B';
  capabilities: CapabilityCache;
  bastionHost: string;
}

/** Decide qué máquina ejecuta el agente para una sesión que vive en `sessionHost`. */
export async function resolveTarget({
  sessionHost, provider, permissionProfile, cwd = null, preferred = 'auto', capabilities, bastionHost,
}: ResolveTargetOptions): Promise<TargetPlan> {
  // aiSessions llama «local» a la máquina desde la que indexó; para Jarvis esa máquina es el
  // bastión, alcanzada por SSH como todo lo demás. `local` nunca se persiste (ADR-005).
  const target = !sessionHost || sessionHost === 'local' ? bastionHost : sessionHost;

  const plan = (
    executionHost: string, workHost: string, strategy: Strategy, reason: string | null,
  ): TargetPlan => ({
    workHost, executionHost, strategy, reason,
    // Bajo estrategia A el agente está en el bastión, donde el cwd del target no existe.
    cwd: strategy === 'A' ? null : cwd ?? null,
    provider, permissionProfile,
  });

  if (target === bastionHost) {
    const bastion = await capabilities.detect(bastionHost);
    if (!bastion.binaries[provider]) {
      throw new TargetImpossibleError('PROVIDER_MISSING',
        `${provider} is not installed on the bastion (${bastionHost})`);
    }
    return plan(bastionHost, bastionHost, 'bastion', null);
  }

  if (preferred === 'A') {
    await capabilities.detect(bastionHost);
    return plan(bastionHost, target, 'A', 'strategy A was requested');
  }

  let remote: HostCapabilities | null = null;
  try {
    remote = await capabilities.detect(target);
  } catch (error) {
    if (preferred === 'B') throw error;
    remote = null; // target inalcanzable: se conduce desde el bastión
  }

  if (remote?.binaries[provider]) return plan(target, target, 'B', null);

  if (preferred === 'B') {
    throw new TargetImpossibleError('STRATEGY_IMPOSSIBLE',
      `${provider} is not installed on ${target}, so strategy B is impossible`);
  }

  const bastion = await capabilities.detect(bastionHost);
  if (!bastion.binaries[provider]) {
    throw new TargetImpossibleError('PROVIDER_MISSING',
      `${provider} is installed neither on ${target} nor on the bastion`);
  }
  return plan(bastionHost, target, 'A',
    remote ? `${provider} is not installed on ${target}` : `${target} could not be probed directly`);
}

/**
 * Bajo estrategia A el agente está en el bastión mientras el trabajo está en otra parte.
 * Decírselo no es opcional: sin esto leerá y editará alegremente el filesystem del bastión.
 */
export function strategyPreamble({
  strategy, workHost, cwd, provider, sessionId,
}: {
  strategy: Strategy; workHost: string; cwd?: string | null; provider?: string | null; sessionId?: string | null;
}): string | null {
  if (strategy !== 'A') return null;
  const lines = [
    '[jarvis] You are running on the bastion, not on the target machine.',
    `The work for this task lives on the host "${workHost}"${cwd ? ` under ${cwd}` : ''}.`,
    `Reach it with ssh, for example: ssh ${workHost} -- <command>.`,
    "Do not read or modify the bastion's own copy of anything; it is not the target.",
  ];
  if (sessionId) {
    lines.push(`This is a fresh session: the ${provider || 'agent'} session "${sessionId}" is stored`
      + ` on ${workHost} and cannot be resumed from here, so read it over ssh if you need its`
      + ' history.');
  }
  return lines.join(' ');
}
