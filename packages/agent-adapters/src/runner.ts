/**
 * El runner remoto: un run vive en el host de ejecución, no en la conexión SSH del core.
 *
 * Todo lo de aquí son funciones puras que construyen comandos y parsean respuestas, para que el
 * contrato del spool (`RUNNER-SPOOL-01`) se pueda fijar con fixtures sin tocar una máquina.
 *
 * Los ficheros y el script viajan en base64: así el prompt del usuario nunca se interpola en una
 * cadena de shell ni puede chocar con un delimitador de heredoc.
 */
import type { Provider, RunStatus, TargetPlan } from '@jarvis/contracts';
import { shellQuote } from './ssh.js';

export const RUNNER_PROTOCOL_VERSION = 1;
export const SPOOL_MARKER = 'JARVIS-SPOOL-V1';

/** Un id de run se usa como nombre de directorio y de sesión tmux: sólo estos caracteres. */
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export class RunnerError extends Error {
  override name = 'RunnerError';
}

export interface SpoolLayout {
  root: string;
  dir: string;
  meta: string;
  events: string;
  stderr: string;
  status: string;
  pid: string;
  cancel: string;
  wrapper: string;
  tmuxName: string;
}

export function spoolLayout(root: string, runId: string): SpoolLayout {
  if (!root.startsWith('/')) throw new RunnerError('the spool root must be an absolute path');
  if (!RUN_ID_PATTERN.test(runId)) throw new RunnerError(`unusable run id: ${JSON.stringify(runId)}`);
  const dir = `${root.replace(/\/+$/, '')}/${runId}`;
  return {
    root,
    dir,
    meta: `${dir}/meta.json`,
    events: `${dir}/events.ndjson`,
    stderr: `${dir}/stderr.log`,
    status: `${dir}/status.json`,
    pid: `${dir}/pid`,
    cancel: `${dir}/cancel`,
    wrapper: `${dir}/wrapper.sh`,
    tmuxName: tmuxRunName(runId),
  };
}

export const tmuxRunName = (runId: string): string => {
  if (!RUN_ID_PATTERN.test(runId)) throw new RunnerError(`unusable run id: ${JSON.stringify(runId)}`);
  return `jarvis-run-${runId}`;
};

/** Metadata saneada. Nunca lleva el prompt ni credenciales: sólo lo que identifica la ejecución. */
export interface RunnerMeta {
  version: number;
  runId: string;
  provider: Provider;
  target: TargetPlan;
  createdAt: string;
  createdBy: string;
  wrapper: string;
}

/**
 * El script que corre dentro de tmux.
 *
 * Publica `status.json` con `.tmp` + `mv`, que en el mismo filesystem es atómico: un lector
 * nunca ve medio documento. Distingue cancelación de fallo por la presencia del marcador
 * `cancel`, porque un agente interrumpido sale con código distinto de cero y eso no es un error.
 */
export function buildWrapperScript(layout: SpoolLayout, agentCommand: string): string {
  const q = (value: string): string => shellQuote(value);
  return `#!/bin/sh
# jarvis runner v${RUNNER_PROTOCOL_VERSION} — generated, do not edit
set -u
DIR=${q(layout.dir)}
STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
PID=0

publish() {
  printf '{"version":${RUNNER_PROTOCOL_VERSION},"state":"%s","pid":%s,"startedAt":"%s","finishedAt":%s,"exitCode":%s}\\n' \\
    "$1" "$PID" "$STARTED" "$2" "$3" > "$DIR/status.json.tmp"
  mv "$DIR/status.json.tmp" "$DIR/status.json"
}

publish running null null

# El agente escribe su stream a events.ndjson; stderr va aparte para no contaminarlo.
( ${agentCommand} ) >> "$DIR/events.ndjson" 2>> "$DIR/stderr.log" &
PID=$!
printf '%s\\n' "$PID" > "$DIR/pid"
publish running null null

wait "$PID"
CODE=$?
FINISHED=$(date -u +%Y-%m-%dT%H:%M:%SZ)

if [ -f "$DIR/cancel" ]; then
  STATE=cancelled
elif [ "$CODE" -eq 0 ]; then
  STATE=completed
else
  STATE=failed
fi
publish "$STATE" "\\"$FINISHED\\"" "$CODE"
`;
};

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

/**
 * Prepara y arranca el run en un solo viaje.
 *
 * Es idempotente a propósito: si la tmux ya existe o ya hay un estado terminal, no se lanza una
 * segunda ejecución. Sin esto, morir entre «ssh envió el comando» y «SQLite confirmó» duplicaría
 * el agente, que es la peor forma de fallar.
 */
export function buildPrepareCommand({
  layout, meta, agentCommand, cwd,
}: {
  layout: SpoolLayout;
  meta: RunnerMeta;
  agentCommand: string;
  cwd?: string | null;
}): string {
  const wrapper = buildWrapperScript(layout, agentCommand);
  const lines = [
    'set -e',
    'umask 077',
    `mkdir -p ${shellQuote(layout.dir)}`,
    `chmod 700 ${shellQuote(layout.dir)}`,
    `printf '%s' ${shellQuote(b64(JSON.stringify(meta)))} | base64 -d > ${shellQuote(layout.meta)}`,
    `printf '%s' ${shellQuote(b64(wrapper))} | base64 -d > ${shellQuote(layout.wrapper)}`,
    `chmod 600 ${shellQuote(layout.meta)}`,
    `chmod 700 ${shellQuote(layout.wrapper)}`,
    `touch ${shellQuote(layout.events)} ${shellQuote(layout.stderr)}`,
    `chmod 600 ${shellQuote(layout.events)} ${shellQuote(layout.stderr)}`,
    // Un estado terminal ya publicado significa que este run ya corrió: no se repite.
    `if [ -f ${shellQuote(layout.status)} ] && grep -q '"state":"\\(completed\\|failed\\|cancelled\\|timed_out\\)"' ${shellQuote(layout.status)} 2>/dev/null; then`,
    '  printf \'%s\\n\' "jarvis:already-finished"',
    `elif tmux has-session -t ${shellQuote(`=${layout.tmuxName}`)} 2>/dev/null; then`,
    '  printf \'%s\\n\' "jarvis:already-running"',
    'else',
    `  tmux new-session -d -s ${shellQuote(layout.tmuxName)}${cwd ? ` -c ${shellQuote(cwd)}` : ''} ${shellQuote(`sh ${layout.wrapper}`)}`,
    '  printf \'%s\\n\' "jarvis:started"',
    'fi',
  ];
  return lines.join('\n');
}

export type PrepareOutcome = 'started' | 'already-running' | 'already-finished';

export function parsePrepareOutput(stdout: string): PrepareOutcome {
  if (stdout.includes('jarvis:already-finished')) return 'already-finished';
  if (stdout.includes('jarvis:already-running')) return 'already-running';
  if (stdout.includes('jarvis:started')) return 'started';
  throw new RunnerError(`unexpected prepare output: ${stdout.slice(0, 200)}`);
}

/**
 * Lee estado y un trozo del stream desde un offset de bytes, en una sola llamada.
 *
 * El cursor de bytes y el `seq` de los eventos son dos cosas distintas: el primero es cómo lee
 * el core, el segundo es identidad pública. Confundirlos es lo que produce duplicados.
 */
export function buildPollCommand({
  layout, offset, maxBytes = 512 * 1024, stderrTailBytes = 2048,
}: { layout: SpoolLayout; offset: number; maxBytes?: number; stderrTailBytes?: number }): string {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new RunnerError('offset must be a non-negative integer');
  const events = shellQuote(layout.events);
  return [
    `SIZE=$(wc -c < ${events} 2>/dev/null || echo 0)`,
    `STATUS=$(cat ${shellQuote(layout.status)} 2>/dev/null | base64 | tr -d '\\n' || true)`,
    // La cola de stderr viaja siempre: cuando un run falla sin escribir un solo evento, esto es
    // lo único que explica por qué, y pedirlo después sería una segunda vuelta que puede no llegar.
    `ERR=$(tail -c ${stderrTailBytes} ${shellQuote(layout.stderr)} 2>/dev/null | base64 | tr -d '\\n' || true)`,
    `if tmux has-session -t ${shellQuote(`=${layout.tmuxName}`)} 2>/dev/null; then ALIVE=1; else ALIVE=0; fi`,
    `printf '${SPOOL_MARKER}\\nsize %s\\nalive %s\\nstatus %s\\nstderr %s\\ndata\\n' "$SIZE" "$ALIVE" "$${'{'}STATUS:--}" "$${'{'}ERR:--}"`,
    `tail -c +${offset + 1} ${events} 2>/dev/null | head -c ${maxBytes} || true`,
  ].join('\n');
}

export interface RemoteStatus {
  version: number;
  state: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out';
  pid: number;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
}

export interface PollResult {
  size: number;
  alive: boolean;
  status: RemoteStatus | null;
  /** Cola de `stderr.log`, para poder explicar un fallo que no llegó a producir eventos. */
  stderr: string;
  chunk: string;
}

export function parsePollOutput(stdout: string): PollResult {
  if (!stdout.startsWith(SPOOL_MARKER)) {
    throw new RunnerError(`spool response is not ${SPOOL_MARKER}`);
  }
  const dataIndex = stdout.indexOf('\ndata\n');
  if (dataIndex === -1) throw new RunnerError('spool response has no data section');
  const header = stdout.slice(SPOOL_MARKER.length + 1, dataIndex + 1);
  const chunk = stdout.slice(dataIndex + '\ndata\n'.length);

  let size = 0;
  let alive = false;
  let status: RemoteStatus | null = null;
  let stderr = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('size ')) size = Number(line.slice(5).trim()) || 0;
    else if (line.startsWith('alive ')) alive = line.slice(6).trim() === '1';
    else if (line.startsWith('stderr ')) {
      const encoded = line.slice(7).trim();
      if (encoded && encoded !== '-') stderr = Buffer.from(encoded, 'base64').toString('utf8');
    } else if (line.startsWith('status ')) {
      const encoded = line.slice(7).trim();
      if (encoded && encoded !== '-') {
        try {
          status = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as RemoteStatus;
        } catch {
          // Un status.json a medio escribir no puede existir (se publica con rename), pero un
          // fichero corrupto no debe romper la ingesta: se ignora y se reintenta en el próximo poll.
          status = null;
        }
      }
    }
  }
  return { size, alive, status, stderr, chunk };
}

/**
 * Pide la cancelación: deja el marcador y manda SIGINT al agente.
 *
 * El marcador es lo que permite al wrapper distinguir «lo pararon» de «falló», y sobrevive a que
 * el core muera entre la señal y la confirmación.
 */
export function buildCancelCommand(layout: SpoolLayout, { escalate = false }: { escalate?: boolean } = {}): string {
  const pid = shellQuote(layout.pid);
  const signal = escalate ? 'KILL' : 'INT';
  const lines = [
    `touch ${shellQuote(layout.cancel)} 2>/dev/null || true`,
    `PID=$(cat ${pid} 2>/dev/null || echo)`,
    `if [ -n "$PID" ]; then kill -${signal} "$PID" 2>/dev/null || true; fi`,
  ];
  if (escalate) {
    lines.push(`tmux kill-session -t ${shellQuote(`=${layout.tmuxName}`)} 2>/dev/null || true`);
  }
  lines.push('printf \'%s\\n\' "jarvis:cancel-sent"');
  return lines.join('\n');
}

/** Limpieza de spools terminados más viejos que el corte. No toca los que siguen vivos. */
export function buildSweepCommand(root: string, olderThanDays: number): string {
  if (!root.startsWith('/')) throw new RunnerError('the spool root must be an absolute path');
  const days = Math.max(1, Math.floor(olderThanDays));
  return [
    `find ${shellQuote(root)} -mindepth 1 -maxdepth 1 -type d -mtime +${days} -exec sh -c '`,
    `  if [ -f "$1/status.json" ] && grep -q \\'"state":"\\\\(completed\\\\|failed\\\\|cancelled\\\\|timed_out\\\\)"\\' "$1/status.json"; then rm -rf -- "$1"; fi`,
    "' sh {} ';' 2>/dev/null || true",
    'printf \'%s\\n\' "jarvis:swept"',
  ].join('\n');
}

/** Cómo se traduce un estado remoto a un estado de run del core. */
export function statusToRunStatus(state: RemoteStatus['state']): RunStatus {
  switch (state) {
    case 'running': return 'running';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'timed_out': return 'timed_out';
    default: return 'failed';
  }
}
