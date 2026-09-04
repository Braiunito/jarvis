/**
 * El vocabulario del producto, en un solo sitio.
 *
 * Los valores internos (`safe`, `running`, `waiting_run`…) son contrato: viajan a las CLIs, a la
 * auditoría y al histórico, así que no se renombran. Lo que sí es nuestro es cómo se cuentan, y
 * una etiqueta tiene que decir **qué puede hacer el agente**, no cómo se llama la bandera de la
 * CLI por dentro.
 */
import type { PermissionProfile, RunStatus } from '@jarvis/contracts';

export interface PermissionLabel {
  name: string;
  help: string;
  tone: 'ok' | 'warn' | 'danger';
}

export const PERMISSION: Record<PermissionProfile, PermissionLabel> = {
  safe: {
    name: 'Sólo lectura',
    help: 'Puede mirar y proponer. No cambia nada en la máquina.',
    tone: 'ok',
  },
  auto: {
    name: 'Puede editar',
    help: 'Escribe ficheros en el destino. Lo que toque, queda tocado.',
    tone: 'warn',
  },
  yolo: {
    name: 'Sin restricciones',
    help: 'Ejecuta cualquier cosa en la máquina, sin aislamiento.',
    tone: 'danger',
  },
};

export const permissionName = (profile: string): string =>
  PERMISSION[profile as PermissionProfile]?.name ?? profile;

export interface StatusLabel {
  name: string;
  tone: 'neutral' | 'running' | 'warn' | 'ok' | 'danger';
  /** Lo que significa para quien mira, no lo que significa en la base. */
  help: string;
}

export const RUN_STATUS: Record<RunStatus, StatusLabel> = {
  queued: { name: 'En cola', tone: 'neutral', help: 'Aceptado; esperando turno para empezar.' },
  preparing: { name: 'Preparando', tone: 'neutral', help: 'Montando el entorno en la máquina.' },
  running: { name: 'Trabajando', tone: 'running', help: 'El agente está en ello ahora mismo.' },
  waiting: { name: 'Esperando', tone: 'warn', help: 'Parado hasta que alguien intervenga.' },
  cancelling: { name: 'Parando', tone: 'warn', help: 'Se pidió parar; falta confirmar que paró.' },
  completed: { name: 'Terminado', tone: 'ok', help: 'Acabó y dejó su resultado.' },
  failed: { name: 'Falló', tone: 'danger', help: 'Terminó mal. El detalle está en los eventos.' },
  cancelled: { name: 'Parado', tone: 'neutral', help: 'Se paró a petición, y está confirmado.' },
  timed_out: { name: 'Sin tiempo', tone: 'danger', help: 'Agotó su plazo y se detuvo.' },
};

/**
 * ¿Esto todavía se mueve solo?
 *
 * Un trabajo vivo puede cambiar sin que nadie toque nada, y por eso la interfaz tiene derecho a
 * animarse; uno terminado se quedó como está, y girar un aspa encima sería mentir. Los cinco
 * estados están aquí y no repartidos por las pantallas para que la respuesta sea la misma en
 * todas.
 */
export const isRunLive = (status: RunStatus): boolean =>
  ['queued', 'preparing', 'running', 'waiting', 'cancelling'].includes(status);

export const PLAN_STATUS: Record<string, StatusLabel> = {
  ready: { name: 'Listo', tone: 'neutral', help: 'Va a decidir el siguiente paso.' },
  running: { name: 'Pensando', tone: 'running', help: 'Decidiendo qué hacer ahora.' },
  waiting_run: { name: 'Trabajando', tone: 'running', help: 'Un agente está ejecutando un paso.' },
  waiting_approval: { name: 'Necesita tu permiso', tone: 'warn', help: 'No sigue sin que lo autorices.' },
  waiting_input: { name: 'Te pregunta algo', tone: 'warn', help: 'Necesita una respuesta tuya.' },
  completed: { name: 'Terminado', tone: 'ok', help: 'Cerró el objetivo con una síntesis.' },
  failed: { name: 'Falló', tone: 'danger', help: 'Se detuvo por un problema.' },
  cancelled: { name: 'Parado', tone: 'neutral', help: 'Se paró antes de terminar.' },
};

export const PLAN_STEP_KIND: Record<string, string> = {
  run: 'trabajo',
  approval: 'permiso',
  input: 'pregunta',
  synthesis: 'cierre',
};

/** Cómo se cuenta de dónde salió lo que se está leyendo. */
export const PROVENANCE: Record<string, string> = {
  'remote-transcript': 'escrito en la máquina',
  'jarvis-run': 'trabajo de Jarvis',
  'litechat-import': 'importado de LiteChat',
  system: 'del sistema',
};

/** Los estados de salud, que la gente lee de un vistazo y sin leer. */
export const HEALTH: Record<string, { name: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' }> = {
  ok: { name: 'bien', tone: 'ok' },
  stale: { name: 'sin refrescar', tone: 'warn' },
  degraded: { name: 'a medias', tone: 'warn' },
  failed: { name: 'caído', tone: 'danger' },
  unknown: { name: 'sin datos', tone: 'neutral' },
};

export const EVENT_KIND: Record<string, string> = {
  'run.target': 'destino',
  'run.status': 'estado',
  'run.cancel_requested': 'petición de parada',
  'runner.stderr': 'salida de error',
  'agent.started': 'el agente arrancó',
  'agent.text': 'respuesta',
  'agent.reasoning': 'razonamiento',
  'agent.tool': 'herramienta',
  'agent.result': 'resultado',
  'agent.error': 'error',
  'agent.raw': 'salida sin clasificar',
};

/**
 * Las ventanas de cuota del agente.
 *
 * Las etiquetas vienen de cada CLI (`session`, `week`, `5h`, `primary`…) y no se renombran por
 * dentro. Lo que se enseña es cuánto **queda**, que es lo que se mira antes de mandar trabajo:
 * «45% usado» obliga a restar mentalmente justo cuando importa no equivocarse.
 */
export const USAGE_WINDOW: Record<string, string> = {
  session: 'sesión',
  week: 'semana',
  '5h': '5 h',
  // Las genéricas sólo salen cuando la ventana no es una de las conocidas: no se les pone una
  // duración inventada, que la de verdad viaja en `windowMinutes`.
  primary: 'principal',
  secondary: 'secundaria',
};

export const usageWindowName = (label: string): string => USAGE_WINDOW[label] ?? label;

/** Por debajo de esto, lo que queda deja de ser un dato y pasa a ser un aviso. */
export const USAGE_LOW_PERCENT = 15;

/**
 * Cómo se llama un trabajo en una lista.
 *
 * Por lo que se pidió, no por su identificador: `rt40nhvqeujq` no le dice nada a nadie, y una
 * lista de doce trabajos con doce identificadores obliga a abrirlos uno a uno para saber cuál es
 * cuál. El identificador sigue estando, debajo y en monoespaciada, que es donde hace falta cuando
 * hay que citarlo.
 */
export function runTitle(run: { promptPreview?: string | null; id: string }, max = 72): string {
  const text = (run.promptPreview ?? '').trim();
  if (!text) return `trabajo ${run.id.slice(0, 8)}`;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * Los checks de salud se identifican por una clave técnica —la que va en «copiar diagnóstico» y
 * la que se nombra al pedir ayuda—, pero al lado conviene decir qué es cada cosa.
 */
export function checkName(key: string): { title: string; id: string } {
  if (key.startsWith('ssh:')) return { title: `Conexión con ${key.slice(4)}`, id: key };
  const known: Record<string, string> = {
    database: 'Base de datos del core',
    aisessions: 'Índice de sesiones',
    runs: 'Trabajos en curso',
    runnerSweep: 'Limpieza de spools',
  };
  return { title: known[key] ?? key, id: key };
}
