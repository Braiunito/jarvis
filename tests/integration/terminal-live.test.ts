/**
 * Mirar y encajar en una terminal viva, contra tmux de verdad.
 *
 * El histórico de una sesión enganchada no está en el navegador: `tmux attach` pinta sobre la
 * pantalla alternativa, así que xterm no acumula nada y no hay scrollback local que mover. Lo que
 * se mueve es el modo copia de tmux, y por eso esta prueba **ejecuta los comandos** contra un
 * servidor tmux propio y le pregunta a tmux dónde ha quedado la vista, en vez de comparar
 * cadenas: una cadena que parece correcta y que ningún tmux acepta se ve igual en un diff.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scrollCommand } from '@jarvis/agent-adapters';

const NAME = `jarvis-scroll-${process.pid}`;
let tmuxDir: string;

/** Todo corre contra un servidor tmux aparte: las sesiones de quien ejecute esto no se tocan. */
const sh = (command: string): string =>
  execFileSync('sh', ['-c', command], {
    encoding: 'utf8',
    env: { ...process.env, TMUX_TMPDIR: tmuxDir },
  }).trim();

const ask = (format: string): string =>
  sh(`tmux display-message -p -t '=${NAME}:' '${format}'`);

const enModoCopia = (): boolean => ask('#{pane_in_mode}') === '1';
const posicion = (): number => Number(ask('#{scroll_position}') || 0);

beforeAll(() => {
  tmuxDir = mkdtempSync(join(tmpdir(), 'jarvis-tmux-'));
  // Una sesión con más líneas de las que caben: sin eso no hay hacia dónde subir.
  sh(`tmux new-session -d -s ${NAME} -x 80 -y 24 'seq 1 500; sleep 120'`);
  // Que termine de escribir antes de mirar.
  execFileSync('sh', ['-c', 'sleep 0.7'], { env: { ...process.env, TMUX_TMPDIR: tmuxDir } });
});

afterAll(() => {
  try { sh(`tmux kill-session -t '=${NAME}'`); } catch { /* ya no estaba */ }
  rmSync(tmuxDir, { recursive: true, force: true });
});

describe('subir y bajar por una sesión viva', () => {
  it('parte del presente: nadie está en modo copia por su cuenta', () => {
    expect(enModoCopia()).toBe(false);
  });

  it('subir entra en modo copia y mueve la vista hacia atrás', () => {
    sh(scrollCommand({ name: NAME, action: 'up' }));
    expect(enModoCopia()).toBe(true);
    expect(posicion()).toBeGreaterThan(0);
  });

  it('subir otra vez llega más arriba', () => {
    const antes = posicion();
    sh(scrollCommand({ name: NAME, action: 'up' }));
    expect(posicion()).toBeGreaterThan(antes);
  });

  it('bajar vuelve hacia el presente', () => {
    const antes = posicion();
    sh(scrollCommand({ name: NAME, action: 'down' }));
    expect(posicion()).toBeLessThan(antes);
  });

  it('«al final» sale del modo copia y devuelve la vista al presente', () => {
    sh(scrollCommand({ name: NAME, action: 'up' }));
    expect(enModoCopia()).toBe(true);
    sh(scrollCommand({ name: NAME, action: 'end' }));
    expect(enModoCopia()).toBe(false);
  });

  it('«al final» se puede pulsar aunque no se hubiera subido: no es un fallo', () => {
    expect(enModoCopia()).toBe(false);
    expect(() => sh(scrollCommand({ name: NAME, action: 'end' }))).not.toThrow();
    expect(enModoCopia()).toBe(false);
  });

  it('subir no escribe nada en la sesión: mirar no es teclear', () => {
    const antes = sh(`tmux capture-pane -p -t '=${NAME}:' | tr -d '[:space:]'`);
    sh(scrollCommand({ name: NAME, action: 'up' }));
    sh(scrollCommand({ name: NAME, action: 'end' }));
    const despues = sh(`tmux capture-pane -p -t '=${NAME}:' | tr -d '[:space:]'`);
    expect(despues).toBe(antes);
  });
});

describe('lo que no es nuestro no se toca', () => {
  it('una sesión sin el prefijo de Jarvis se rechaza antes de construir el comando', () => {
    expect(() => scrollCommand({ name: 'la-tmux-de-otro', action: 'up' })).toThrow();
  });
});

/**
 * Redimensionar un cliente enganchado.
 *
 * Esto estuvo roto desde el principio sin que se notara: el core pedía el cambio con
 * `tmux refresh-client -C`, que **sólo vale para clientes de modo control** y contra un attach
 * normal responde «not a control client». Como el tamaño inicial lo fija el `stty` de antes del
 * attach, casi nadie lo veía; salió al estrenar la pantalla completa, donde el hueco se duplica de
 * golpe y tmux seguía pintando al tamaño de antes.
 *
 * Aquí hay un cliente de verdad —`script` da el pty que hace falta— y se comprueba lo que tmux
 * dice de él, que es lo único que importa.
 */
describe('encajar el tamaño de quien mira', () => {
  const SESION = `jarvis-resize-${process.pid}`;
  let attachado: ReturnType<typeof spawn> | null = null;

  const clienteTty = (): string =>
    sh(`tmux list-clients -t '=${SESION}:' -F '#{client_tty}' 2>/dev/null | head -1`);
  const tamano = (): string =>
    sh(`tmux list-clients -t '=${SESION}:' -F '#{client_width}x#{client_height}' 2>/dev/null | head -1`);

  beforeAll(async () => {
    sh(`tmux new-session -d -s ${SESION} -x 80 -y 24 'sleep 120'`);
    // Un cliente con pseudo-terminal de verdad: sin pty no hay tamaño que cambiar.
    attachado = spawn('script', ['-q', '-c', `tmux attach -t '=${SESION}:'`, '/dev/null'], {
      env: { ...process.env, TMUX_TMPDIR: tmuxDir, TERM: 'xterm-256color' },
      stdio: 'ignore',
      detached: true,
    });
    for (let intento = 0; intento < 40 && !clienteTty(); intento += 1) {
      await new Promise((listo) => setTimeout(listo, 100));
    }
  });

  afterAll(() => {
    attachado?.kill('SIGKILL');
    try { sh(`tmux kill-session -t '=${SESION}'`); } catch { /* ya no estaba */ }
  });

  it('hay un cliente enganchado con su tty', () => {
    expect(clienteTty()).toMatch(/^\/dev\//);
  });

  it('`refresh-client -C` no sirve para esto, y por eso no se usa', () => {
    const tty = clienteTty();
    const salida = sh(`tmux refresh-client -t '${tty}' -C 170x40 2>&1 || true`);
    expect(salida).toContain('not a control client');
  });

  it('cambiar el tamaño del pty sí llega: el cliente y la ventana le siguen', async () => {
    const tty = clienteTty();
    const antes = tamano();
    sh(`stty -F '${tty}' rows 40 cols 170`);
    for (let intento = 0; intento < 30 && tamano() === antes; intento += 1) {
      await new Promise((listo) => setTimeout(listo, 100));
    }
    expect(tamano()).toBe('170x40');
    expect(sh(`tmux display-message -p -t '=${SESION}:' '#{window_width}'`)).toBe('170');
  });
});
