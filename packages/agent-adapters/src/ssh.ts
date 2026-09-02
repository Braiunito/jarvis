/**
 * El transporte SSH. Todo comando remoto pasa por aquí, incluidos los que van al propio bastión:
 * el bastión es un host SSH más (decisión D1), así que hay un solo camino de código que auditar.
 *
 * Dos reglas sostienen la seguridad de todo el core:
 *
 *   1. El nombre del host se compara contra una allowlist antes de llegar a `ssh`. Siempre hay
 *      allowlist — una vacía se rechaza, no se lee como «cualquier cosa» — porque sin ella un
 *      nombre como `-oProxyCommand=...` lo leería ssh como opción y ejecutaría código local.
 *   2. Los comandos remotos se ensamblan sólo con `shellQuote`. Texto del usuario —un prompt, un
 *      path, un id de sesión— nunca se interpola crudo en una cadena de shell.
 *
 * Contratos: SSH-QUOTE-01, SSH-SCRIPT-01, SSH-ALLOW-01, SSH-ARGV-01.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable } from 'node:stream';

export class SshError extends Error {
  override name = 'SshError';
}

/** Un host no puede empezar por guion: `ssh -Fx` es una opción, no una máquina. */
const HOST_PATTERN = /^[A-Za-z0-9._@][A-Za-z0-9._@-]*$/;

export const DEFAULT_REMOTE_PATH =
  '$HOME/.local/bin:$HOME/.opencode/bin:$HOME/.bun/bin:$HOME/bin:/usr/local/bin';

export interface SshConfig {
  /** Binario de ssh. Los tests apuntan a un ssh falso. */
  sshCommand: string;
  sshOptions: string[];
  hosts: string[];
  bastionHost: string;
  knownHostsFile: string;
  remotePath: string;
}

export const defaultSshConfig = (overrides: Partial<SshConfig> = {}): SshConfig => ({
  sshCommand: 'ssh',
  sshOptions: [],
  hosts: [],
  bastionHost: 'bastion',
  knownHostsFile: '/tmp/jarvis-known-hosts',
  remotePath: DEFAULT_REMOTE_PATH,
  ...overrides,
});

/**
 * Prefijo PATH para un comando remoto.
 *
 * `ssh host -- comando` corre un shell no interactivo y no de login, que en la mayoría de
 * sistemas no lee .bashrc ni .zshrc: cada instalación por usuario desaparece del PATH y una
 * máquina con Codex en ~/.local/bin parece una máquina sin nada instalado. Se emite sin comillas
 * para que el shell remoto expanda $HOME, y por eso el valor se restringe a un charset que no
 * puede colar un comando.
 */
export function remotePathExport(extra: string = DEFAULT_REMOTE_PATH): string {
  if (!extra) return '';
  if (!/^[A-Za-z0-9_$:{}./~-]+$/.test(extra)) {
    throw new SshError(`unsafe remote PATH: ${JSON.stringify(extra)}`);
  }
  return `export PATH=${extra}:$PATH; `;
}

/**
 * Entrecomilla un argumento para un shell remoto.
 *
 * El conjunto sin comillas es deliberadamente más estrecho que `shlex.quote`: shlex asume sh,
 * pero el shell de login del otro lado suele ser zsh, donde un `=` inicial es expansión de
 * fichero (`=tmux` se convierte en la ruta de tmux) y `~` es expansión de home. Dejarlos
 * desnudos hacía fallar `tmux -t =jarvis-...` con «not found» mientras la sesión existía.
 */
export function shellQuote(value: unknown): string {
  const text = String(value);
  if (text.length === 0) return "''";
  if (/^[A-Za-z0-9@%_+:,./-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

export const shellJoin = (argv: readonly unknown[]): string => argv.map(shellQuote).join(' ');

export interface RemoteScriptOptions {
  argv: readonly string[];
  cwd?: string | null;
  env?: Record<string, string> | null;
  pathExtra?: string;
  /** Un run headless no teclea nada; dejarle un pipe abierto hace esperar a algunas CLIs. */
  stdinFromNull?: boolean;
}

export function remoteScript({
  argv, cwd, env, pathExtra = DEFAULT_REMOTE_PATH, stdinFromNull = false,
}: RemoteScriptOptions): string {
  const parts: string[] = [];
  const prefix = remotePathExport(pathExtra);
  if (cwd) parts.push(`cd ${shellQuote(cwd)} &&`);
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new SshError(`unsafe environment name: ${key}`);
    parts.push(`${key}=${shellQuote(value)}`);
  }
  parts.push(shellJoin(argv));
  if (stdinFromNull) parts.push('< /dev/null');
  return prefix + parts.join(' ');
}

export function assertHostAllowed(host: string, allowlist: readonly string[]): void {
  if (!HOST_PATTERN.test(host)) {
    throw new SshError(`refusing suspicious host name: ${JSON.stringify(host)}`);
  }
  if (!allowlist || allowlist.length === 0) {
    throw new SshError('no host allowlist is configured (JARVIS_HOSTS)');
  }
  if (!allowlist.includes(host)) {
    throw new SshError(`host ${host} is not in JARVIS_HOSTS`);
  }
}

export interface SshArgvOptions {
  host: string;
  command: string;
  config: SshConfig;
  tty?: boolean;
  batch?: boolean;
}

export function sshArgv({ host, command, config, tty = false, batch = true }: SshArgvOptions): string[] {
  assertHostAllowed(host, config.hosts);
  const argv = [config.sshCommand];
  if (tty) argv.push('-tt');
  if (batch) argv.push('-o', 'BatchMode=yes');
  argv.push('-o', 'StrictHostKeyChecking=accept-new');
  // El ~/.ssh montado es de sólo lectura, así que ssh no puede anotar allí una clave recién
  // aceptada y avisa por stderr en cada llamada: ese aviso acabaría dentro de la salida del
  // agente. Se le da un fichero escribible salvo que el operador ya haya elegido uno.
  if (config.knownHostsFile && !config.sshOptions.some((o) => String(o).includes('UserKnownHostsFile'))) {
    argv.push('-o', `UserKnownHostsFile=${config.knownHostsFile}`);
  }
  argv.push(...config.sshOptions);
  argv.push(host, '--', command);
  return argv;
}

export interface SshResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function sshSpawn(options: SshArgvOptions): ChildProcessWithoutNullStreams {
  const [bin, ...args] = sshArgv(options);
  return spawn(bin as string, args, { stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Ejecuta un comando corto y acotado por SSH y recoge su salida. */
export function sshExec(
  options: SshArgvOptions,
  { timeoutMs = 20_000, input }: { timeoutMs?: number; input?: string } = {},
): Promise<SshResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = sshSpawn(options);
    } catch (error) {
      reject(error);
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new SshError(`timed out after ${timeoutMs}ms: ssh ${options.host}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => { clearTimeout(timer); reject(new SshError(error.message)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

/**
 * Lee stdout como registros separados por salto de línea. Una línea parcial al final de un chunk
 * se guarda hasta que llega el resto: ese es exactamente el bug que este ayudante evita.
 */
export function forEachLine(stream: Readable, onLine: (line: string) => void): void {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      if (line.trim()) onLine(line);
      index = buffer.indexOf('\n');
    }
  });
  stream.on('end', () => {
    if (buffer.trim()) onLine(buffer.trim());
  });
}

/**
 * ssh escribe en stderr cosas locuaces pero inofensivas —aceptar una host key, banners— y llegan
 * *antes* de la línea que dice qué falló de verdad. Reportar la primera línea le cuenta al
 * operador «Permanently added...» cuando la respuesta real es «Permission denied».
 */
const BENIGN_SSH_STDERR = [
  /^Warning: Permanently added/i,
  /^Warning: the ECDSA host key/i,
  /^Pseudo-terminal will not be allocated/i,
  /^Authorized uses only/i,
  /^\s*$/,
];

export function sshFailureReason(result: Pick<SshResult, 'code' | 'stderr'>): string {
  const meaningful = (result.stderr || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !BENIGN_SSH_STDERR.some((pattern) => pattern.test(line)));

  if (meaningful.length) return meaningful[meaningful.length - 1] as string;
  if (result.code === 255) {
    return 'ssh could not establish the connection (key rejected, host down, or wrong user)';
  }
  return `ssh exited ${result.code}`;
}
