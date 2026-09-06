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

/**
 * Cuánto está pensando, dicho para quien mira.
 *
 * `low`, `medium` y `high` son las palabras de la API y no dicen nada de lo que va a pasar: lo
 * que quiere saber quien lee es si esta pregunta le ha parecido fácil o si se está tomando su
 * tiempo, porque eso es lo que explica que la respuesta tarde ocho segundos o treinta.
 *
 * El nivel lo decide una pasada previa barata que **no deja rastro en el hilo**: no llama a
 * ninguna herramienta y no escribe ningún mensaje. Así que este indicador es el único sitio donde
 * se ve que esa decisión existió, y por eso dice también el porqué en su ayuda.
 *
 * `minimal` no está y no es un olvido: el juez lo elige, pero el turno que **contesta** nunca corre
 * con él —no compone una frase— así que a la pantalla no llega nunca. Tenerlo aquí era una etiqueta
 * que no se podía ver, comprobado pidiéndole un saludo a producción: el juez dijo lo suyo y la línea
 * puso «poco». Si algún día interesa ver lo que decidió el juez, será por un motivo y con su campo,
 * no por completar la escala.
 */
export const EFFORT: Record<string, { name: string; help: string; tone: 'ok' | 'neutral' | 'warn' }> = {
  low: {
    name: 'poco',
    help: 'Le ha parecido una pregunta directa y no se va a entretener.',
    tone: 'ok',
  },
  medium: {
    name: 'lo normal',
    help: 'Esfuerzo intermedio: ni una respuesta de memoria ni un análisis largo.',
    tone: 'neutral',
  },
  high: {
    name: 'a fondo',
    help: 'Le ha parecido que esto pide pensar. Tarda más y cuesta más.',
    tone: 'warn',
  },
};

export const effortName = (effort: string): string => EFFORT[effort]?.name ?? effort;

/**
 * Cuánta cuerda tiene el asistente sin tu firma.
 *
 * Estaba escrito a mano en la pantalla, y por eso se quedó viejo: la pista de «Automático» decía que
 * el trabajo con permiso de escritura salía sin tarjeta, que era verdad cuando se escribió y dejó de
 * serlo en cuanto el core cumplió su contrato. Aquí vive una vez, al lado del resto del vocabulario,
 * y se lee del mismo sitio que lo lee el que lo cambie.
 *
 * `unrestricted` se llama **«Sin preguntar»** y no «sin restricciones», que es el nombre del perfil
 * `yolo`: uno dice qué permiso lleva un trabajo y el otro cuánta firma hace falta. Compartir palabra
 * entre los dos ejes es enseñar a leer una tarjeta de aprobación por encima.
 */
export const AUTONOMY: Record<string, { name: string; help: string; tone: 'neutral' | 'warn' | 'danger' }> = {
  manual: {
    name: 'Manual',
    help: 'Todo lo que tenga efectos te lo pregunta antes, incluido lanzar un trabajo en modo seguro.',
    tone: 'neutral',
  },
  auto: {
    name: 'Automático',
    help: 'El trabajo en modo seguro y las lecturas van solos. Escribir en una máquina y las '
      + 'capacidades con efectos siguen pidiéndote tarjeta, igual que salir a la nube.',
    tone: 'warn',
  },
  unrestricted: {
    name: 'Sin preguntar',
    help: 'Además van solos el trabajo que escribe y las capacidades **etiquetadas** con efectos. '
      + 'Lo desconocido no: una capacidad sin etiquetar sigue pidiendo tarjeta. Y nunca van solos el '
      + 'perfil sin restricciones, salir a la nube ni parar trabajo que lanzaste tú.',
    tone: 'danger',
  },
};

export const autonomyName = (mode: string): string => AUTONOMY[mode]?.name ?? mode;

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
