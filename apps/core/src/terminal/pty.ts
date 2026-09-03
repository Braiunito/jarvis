/**
 * Una terminal remota de verdad.
 *
 * `ssh -tt` reserva un pseudo-terminal en el otro lado aunque nuestros stdio sean tuberías, así
 * que el agente recibe un TTY auténtico y nosotros su flujo de bytes: cada secuencia de escape,
 * tal cual se escribió. Las pulsaciones vuelven por el mismo camino, sin tocar.
 *
 * Dos detalles deciden si la interfaz del agente funciona siquiera:
 *
 *   TERM   un TERM vacío deja al TUI sin poder colocar el cursor ni dibujar un recuadro.
 *   size   sin tamaño de ventana el remoto reporta 0x0, y lo que se maqueta al ancho del
 *          terminal o se envuelve en algo ilegible o directamente no se dibuja.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  remotePathExport, scrollCommand, shellQuote, sshArgv,
  type ScrollAction, type SshConfig,
} from '@jarvis/agent-adapters';
import { JarvisError } from '@jarvis/contracts';

const NAME_PATTERN = /^jarvis-[A-Za-z0-9_.-]+$/;

/** Acotado a algo que un terminal pueda ser: un cliente no puede pedir 0x0. */
const sane = (value: unknown, fallback: number, max: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 4) return fallback;
  return Math.min(Math.floor(parsed), max);
};

export interface AttachOptions {
  host: string;
  name: string;
  cols?: number;
  rows?: number;
  config: SshConfig;
}

export function attachPty({ host, name, cols = 120, rows = 32, config }: AttachOptions):
{ child: ChildProcessWithoutNullStreams; command: string } {
  if (!NAME_PATTERN.test(name)) {
    throw new JarvisError('FORBIDDEN',
      `refusing to attach to ${JSON.stringify(name)}: not managed by Jarvis`, { scope: { host } });
  }

  const width = sane(cols, 120, 500);
  const height = sane(rows, 32, 200);

  /**
   * `stty` va antes del attach porque ese es el único momento en que tmux lee el tamaño del TTY.
   *
   * Sin `-u`: `attach-session` nunca ha tenido esa opción —es de `new-session` y `resize-window`—
   * así que tmux responde «unknown flag -u» y el attach falla del todo.
   */
  const remote = remotePathExport(config.remotePath)
    + 'export TERM=xterm-256color; '
    + `stty rows ${height} cols ${width} 2>/dev/null; `
    + `exec tmux attach -t ${shellQuote(`=${name}:`)}`;

  const argv = sshArgv({
    host,
    command: remote,
    config,
    // El TTY es justo el objetivo aquí, y sin BatchMode se quedaría colgado en una petición de
    // contraseña, así que la clave ya tiene que funcionar: a estas alturas la sonda lo confirmó.
    tty: true,
    batch: true,
  });

  const [bin, ...args] = argv;
  const child = spawn(bin as string, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  return { child, command: remote };
}

/**
 * Le dice a tmux que el cliente ahora tiene otro tamaño.
 *
 * Se hace cambiando el tamaño del pseudo-terminal, no pidiéndoselo a tmux. La diferencia no es de
 * estilo: `tmux refresh-client -C` **sólo vale para clientes de modo control** (`tmux -C`), y
 * contra un attach normal responde «not a control client» y no cambia nada. Estuvo así desde el
 * principio, sin que se notara, porque el tamaño inicial lo fija el `stty` de antes del attach y
 * casi nadie cambiaba la ventana después; se vio al estrenar la pantalla completa, donde el hueco
 * se duplica de golpe y tmux seguía pintando 137x25 en una pantalla de 170x40.
 *
 * `stty -F <tty>` cambia el tamaño del pty en el kernel, que manda `SIGWINCH` a quien esté
 * dentro. Es lo que ocurre de verdad cuando alguien estira la ventana de su terminal, y es lo
 * único que tmux escucha aquí. Comprobado contra el bastión: con `refresh-client` el cliente se
 * quedaba en 137x25; con `stty` pasa a 170x40 y la ventana le sigue.
 */
export function resizePty({ host, clientTty, cols, rows, config }: {
  host: string; clientTty: string | null; cols: number; rows: number; config: SshConfig;
}): Promise<boolean> {
  if (!clientTty || !/^[A-Za-z0-9/_-]+$/.test(clientTty)) return Promise.resolve(false);
  const width = sane(cols, 120, 500);
  const height = sane(rows, 32, 200);

  const argv = sshArgv({
    host,
    command: `stty -F ${shellQuote(clientTty)} rows ${height} cols ${width}`,
    config,
  });
  const [bin, ...args] = argv;
  return new Promise((resolve) => {
    const child = spawn(bin as string, args, { stdio: 'ignore' });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

/**
 * Mueve la vista de una sesión viva hacia atrás o hacia delante.
 *
 * Va por una conexión ssh aparte, como el redimensionado: el TTY del attach es para las teclas de
 * quien mira, y meter por ahí comandos de tmux significaría adivinar su prefijo.
 */
export function scrollPty({ host, name, action, config }: {
  host: string; name: string; action: ScrollAction; config: SshConfig;
}): Promise<boolean> {
  let command: string;
  try {
    command = scrollCommand({ name, action });
  } catch {
    // Un nombre que no es nuestro no se toca, y tampoco se convierte en un error del socket.
    return Promise.resolve(false);
  }
  const argv = sshArgv({ host, command, config });
  const [bin, ...args] = argv;
  return new Promise((resolve) => {
    const child = spawn(bin as string, args, { stdio: 'ignore' });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

/** Qué tty le dio tmux a esta conexión, para poder redimensionarla después. */
export function findClientTty({ host, name, config }: { host: string; name: string; config: SshConfig }): Promise<string | null> {
  const argv = sshArgv({
    host,
    command: `tmux list-clients -t ${shellQuote(`=${name}:`)} -F '#{client_tty}' 2>/dev/null | head -1`,
    config,
  });
  const [bin, ...args] = argv;
  return new Promise((resolve) => {
    const child = spawn(bin as string, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString(); });
    child.on('close', () => resolve(out.trim().split('\n').pop() ?? null));
    child.on('error', () => resolve(null));
  });
}
