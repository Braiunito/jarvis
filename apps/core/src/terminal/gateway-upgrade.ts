/**
 * El extremo WebSocket de la terminal.
 *
 * El socket es transporte y nada más: desconectarlo no mata la tmux del otro lado, y volver a
 * conectarse no crea una segunda. Lo único que se audita aquí es abrir, adjuntar y soltar; el
 * contenido del TTY no se guarda.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { detachClientCommand, sshExec, type SshConfig } from '@jarvis/agent-adapters';
import { verifyIdentityHeader, internalSecret, IDENTITY_HEADER } from '../auth-boundary/identity.js';
import type { AuditLog } from '../platform/audit.js';
import { attachPty, findClientTty, resizePty, scrollPty } from './pty.js';
import { accept, rejectUpgrade, type WebSocketConnection } from './websocket.js';

/**
 * Las conexiones vivas, para poder cerrarlas al apagar.
 *
 * Sin esto, un `docker stop` se queda esperando a sockets que nadie va a cerrar y el contenedor
 * muere por timeout en vez de por decisión propia.
 */
export const liveTerminals = new Set<WebSocketConnection>();

export function closeAllTerminals(reason = 'server shutting down'): void {
  for (const connection of liveTerminals) connection.close(1001, reason);
  liveTerminals.clear();
}

export interface TerminalUpgradeDeps {
  sshConfig: SshConfig;
  audit: AuditLog;
  allowedHosts: readonly string[];
  /** Sólo en tests: aceptar sin la firma del gateway hay que pedirlo a propósito. */
  trustAllIdentities?: boolean;
}

export function handleTerminalUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  deps: TerminalUpgradeDeps,
): void {
  // Nada aquí puede lanzar: una excepción en un handler de socket es una excepción no capturada,
  // y eso termina el proceso para todo el mundo.
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/events/terminal') {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }

    const identity = deps.trustAllIdentities
      ? { userId: 'test-user', username: 'test' }
      : verifyIdentityHeader(req.headers[IDENTITY_HEADER] as string | undefined, internalSecret());
    if (!identity) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }

    const host = url.searchParams.get('host') ?? '';
    const name = url.searchParams.get('name') ?? '';
    if (!deps.allowedHosts.includes(host)) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }

    const connection = accept(req, socket, head);
    if (!connection) return;
    liveTerminals.add(connection);
    connection.on('close', () => liveTerminals.delete(connection));

    let child;
    try {
      child = attachPty({
        host,
        name,
        cols: Number(url.searchParams.get('cols') ?? 120),
        rows: Number(url.searchParams.get('rows') ?? 32),
        config: deps.sshConfig,
      }).child;
    } catch (error) {
      connection.send(`\r\n[jarvis] ${(error as Error).message}\r\n`);
      connection.close(1011, 'attach failed');
      return;
    }

    deps.audit.record({
      actorUser: identity.username, eventType: 'terminal.attached', host, payload: { name },
    });

    child.stdout.on('data', (chunk: Buffer) => connection.send(chunk));
    child.stderr.on('data', (chunk: Buffer) => connection.send(chunk));
    child.on('close', () => {
      connection.send('\r\n[jarvis] la conexión con la terminal terminó\r\n');
      connection.close(1000, 'ssh closed');
    });
    child.on('error', (error) => {
      connection.send(`\r\n[jarvis] ${error.message}\r\n`);
      connection.close(1011, 'ssh error');
    });

    let clientTty: string | null = null;
    void findClientTty({ host, name, config: deps.sshConfig }).then((tty) => { clientTty = tty; });

    connection.on('message', (message: Buffer, isBinary: boolean) => {
      const text = message.toString('utf8');
      // Los mensajes de control son JSON; todo lo demás son bytes del teclado. Un JSON que no
      // reconocemos se escribe tal cual: mejor teclear de más que tragarse una pulsación.
      if (!isBinary && text.startsWith('{')) {
        try {
          const control = JSON.parse(text) as {
            type?: string; cols?: number; rows?: number; action?: string;
          };
          if (control.type === 'resize') {
            const cols = control.cols ?? 120;
            const rows = control.rows ?? 32;
            /**
             * Si al conectar no se supo qué tty le dio tmux al cliente, se vuelve a preguntar.
             *
             * Antes se resolvía una sola vez y, si esa consulta llegaba tarde o fallaba, este
             * cliente se quedaba sin poder redimensionar **para siempre**: el navegador estiraba
             * su rejilla y tmux seguía pintando al tamaño viejo, con la barra de estado a media
             * pantalla. Se ve mucho al entrar a pantalla completa, que es cuando el hueco cambia
             * de golpe y sin que cambie la ventana.
             */
            if (clientTty) {
              void resizePty({ host, clientTty, cols, rows, config: deps.sshConfig });
            } else {
              void findClientTty({ host, name, config: deps.sshConfig }).then((tty) => {
                clientTty = tty;
                if (tty) void resizePty({ host, clientTty: tty, cols, rows, config: deps.sshConfig });
              });
            }
            return;
          }
          /**
           * Mirar hacia atrás sin escribir nada.
           *
           * En un teléfono no hay rueda de ratón ni teclas de página, y el histórico no está en
           * el navegador: `tmux attach` pinta sobre la pantalla alternativa, así que xterm no
           * guarda nada que enseñar. Quien mira necesita poder subir, y hacerlo sin teclear.
           */
          if (control.type === 'scroll') {
            const action = control.action === 'up' || control.action === 'down' || control.action === 'end'
              ? control.action
              : null;
            if (action) void scrollPty({ host, name, action, config: deps.sshConfig });
            return;
          }
          if (control.type === 'ping') {
            connection.ping();
            return;
          }
        } catch {
          // No era control: se escribe como entrada.
        }
      }
      if (!child.killed && child.stdin.writable) child.stdin.write(message);
    });

    /**
     * Cerrar el socket sólo cierra el socket: la tmux sigue viva y con ella el trabajo.
     *
     * El orden importa. Primero se le pide a tmux un detach limpio y sólo después se cierra el
     * ssh: al revés, el cliente muere con su terminal de control por delante y se ha visto
     * llevarse la sesión entera, que es justo lo que esta pantalla promete que no pasa.
     */
    const release = (): void => {
      void sshExec({ host, command: detachClientCommand(name), config: deps.sshConfig }, { timeoutMs: 10_000 })
        .catch(() => undefined)
        .finally(() => {
          if (!child.killed) child.kill('SIGHUP');
        });
    };

    connection.on('close', () => {
      deps.audit.record({
        actorUser: identity.username, eventType: 'terminal.detached', host, payload: { name },
      });
      release();
    });

    connection.on('error', () => release());

    const heartbeat = setInterval(() => {
      if (connection.closed) {
        clearInterval(heartbeat);
        return;
      }
      connection.ping();
    }, 30_000);
    heartbeat.unref?.();
  } catch (error) {
    console.error('[core] terminal upgrade failed:', (error as Error).message);
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  }
}
