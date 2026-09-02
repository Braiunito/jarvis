/**
 * tmux: continuidad real de una sesión interactiva.
 *
 * Los nombres llevan prefijo y se validan, así que esto no puede tocar una sesión que Jarvis no
 * creó. Contrato: TERM-TMUX-01.
 */
import { remoteScript, shellJoin, shellQuote } from './ssh.js';

const NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;
export const TMUX_PREFIX = 'jarvis';

export class TmuxError extends Error {
  override name = 'TmuxError';
}

export function sessionName(key: string): string {
  const clean = String(key).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 60);
  const name = `${TMUX_PREFIX}-${clean}`;
  if (!NAME_PATTERN.test(name)) throw new TmuxError(`unusable tmux session name: ${name}`);
  return name;
}

/**
 * Cómo se nombra un objetivo, que difiere por comando.
 *
 * `=name` significa «la sesión llamada exactamente así» y es lo correcto para comandos de sesión.
 * Los comandos de panel (capture-pane, send-keys) resuelven un *panel*, y allí `=name` hace que
 * tmux busque un panel con ese nombre y conteste «can't find pane» con la sesión funcionando. Los
 * dos puntos finales dicen «el panel activo de esa sesión» y conservan la exactitud del `=`.
 */
export const sessionTarget = (name: string): string => `=${name}`;
export const paneTarget = (name: string): string => `=${name}:`;

export function assertOurs(name: string): void {
  if (!NAME_PATTERN.test(name) || !name.startsWith(`${TMUX_PREFIX}-`)) {
    throw new TmuxError(`refusing to touch tmux session ${JSON.stringify(name)}: not managed by Jarvis`);
  }
}

export const hasSessionCommand = (name: string): string => {
  assertOurs(name);
  return `tmux has-session -t ${shellQuote(sessionTarget(name))} 2>/dev/null`;
};

export function newSessionCommand({
  name, argv, cwd, env,
}: { name: string; argv: readonly string[]; cwd?: string | null; env?: Record<string, string> | null }): string {
  assertOurs(name);
  const inner = remoteScript({ argv, cwd: null, env: env ?? null });
  const parts = ['tmux', 'new-session', '-d', '-s', name];
  if (cwd) parts.push('-c', cwd);
  return `${shellJoin(parts)} ${shellQuote(inner)}`;
}

export const killSessionCommand = (name: string): string => {
  assertOurs(name);
  return `tmux kill-session -t ${shellQuote(sessionTarget(name))}`;
};

/**
 * Despedirse del cliente antes de cerrar el transporte.
 *
 * Matar el proceso del attach a lo bruto deja al servidor tmux con un cliente cuyo terminal se
 * evaporó, y en esa situación se ha visto llevarse la sesión por delante. Un `detach-client` es
 * una línea y convierte «desconectar» en lo que dice ser: dejar de mirar.
 */
export const detachClientCommand = (name: string): string => {
  assertOurs(name);
  return `tmux detach-client -s ${shellQuote(sessionTarget(name))} 2>/dev/null || true`;
};

export const listSessionsCommand = (): string => {
  const format = '#{session_name}\t#{session_created}\t#{session_attached}\t#{session_windows}';
  return `tmux list-sessions -F ${shellQuote(format)} 2>/dev/null || true`;
};

export interface ParsedTmuxSession {
  name: string;
  createdAt: string | null;
  attached: boolean;
  windows: number;
}

export function parseSessionList(stdout: string): ParsedTmuxSession[] {
  return stdout.split('\n')
    .map((line) => line.split('\t'))
    .filter((parts): parts is [string, string, string, string] =>
      Boolean(parts[0]) && parts[0]!.startsWith(`${TMUX_PREFIX}-`))
    .map(([name, created, attached, windows]) => ({
      name,
      createdAt: created ? new Date(Number(created) * 1000).toISOString() : null,
      attached: attached === '1',
      windows: Number(windows || 1),
    }));
}

export function capturePaneCommand({ name, lines = 200, escapes = false }: { name: string; lines?: number; escapes?: boolean }): string {
  assertOurs(name);
  const flags = ['capture-pane', '-p', '-t', paneTarget(name), '-S', `-${Math.max(1, Math.min(lines, 5000))}`];
  if (escapes) flags.push('-e');
  return `tmux ${shellJoin(flags)}`;
}
