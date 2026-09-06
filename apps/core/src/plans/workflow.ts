/**
 * El perímetro de un workflow: construirlo, firmarlo y comprobar que no se sale.
 *
 * Todo aquí es puro y sin base de datos a propósito. Es la pieza que decide si una acción se
 * ejecuta sin preguntar o se convierte en tarjeta, así que tiene que poder probarse a fondo sin
 * levantar nada — y tiene que poder leerse entera de una sentada, que es lo que hace que alguien
 * se atreva a cambiarla dentro de un año.
 *
 * La idea que lo ordena: **no se firma la lista de pasos, se firma el perímetro**. Un plan
 * estimativo va a cambiar por definición; firmar los pasos lo invalidaría en la primera corrección
 * y la salida sería pedir tarjeta por cada paso, que es lo que un workflow existe para evitar.
 */
import { createHash } from 'node:crypto';
import type { PermissionProfile, PlanStep, WorkflowEnvelope } from '@jarvis/contracts';

/** Del que menos deja al que más. Comparar perfiles es comparar posiciones aquí. */
const LADDER: readonly PermissionProfile[] = ['safe', 'auto', 'yolo'];

/** Un perfil que escribe en la máquina. `safe` mira y propone; los otros dos tocan. */
const writes = (profile: PermissionProfile): boolean => profile !== 'safe';

/**
 * Cuánto del `output` de un paso viaja al contexto del siguiente.
 *
 * Un workflow de ocho pasos con ocho salidas enteras crece rápido, y quien lo paga es el modelo en
 * cada turno. Se recorta por paso y **se dice que se recorta**, igual que en las herramientas: lo
 * que va acotado lo dice. Si un paso necesita de verdad su salida completa, eso es evidencia y se
 * pide con `get_run`, que es para lo que está.
 */
export const MAX_STEP_OUTPUT_CHARS = 1200;

export interface DraftStep {
  title: string;
  intent: string;
  expects: string;
  unknowns?: string[];
  writes?: boolean;
}

export interface DraftWorkflow {
  objective: string;
  steps: DraftStep[];
  hosts?: string[];
  maxRuns?: number;
  highestPermissionProfile: PermissionProfile;
  capabilities?: string[];
}

export interface EnvelopeLimits {
  /** La allowlist de la casa. Un sobre no puede firmar una máquina que el core no alcanza. */
  allowedHosts: readonly string[];
  /** Tope de pasos del motor de planes. El sobre no puede prometer más de lo que cabe. */
  maxSteps: number;
}

export type EnvelopeResult =
  | { ok: true; envelope: WorkflowEnvelope }
  | { ok: false; message: string; hint?: string };

/**
 * Construye el sobre a partir de lo que propuso el modelo, acotándolo a lo que la casa permite.
 *
 * Lo que llega es una propuesta, no una orden: los hosts se cruzan con la allowlist, el permiso se
 * recorta por arriba y `yolo` no se firma nunca aquí. Que `yolo` no pase por esta puerta no es
 * prudencia genérica: lo que aporta la ruta de aprobación no es el perfil, es **la tarjeta** que
 * enseña qué se va a ejecutar y caduca. Un sobre firmado una vez no puede conceder eso para media
 * hora de pasos que aún no existen.
 */
export function buildEnvelope(draft: DraftWorkflow, limits: EnvelopeLimits): EnvelopeResult {
  if (!draft.objective.trim()) {
    return { ok: false, message: 'un workflow necesita un objetivo' };
  }
  if (draft.steps.length === 0) {
    return { ok: false, message: 'un workflow sin pasos no es un plan' };
  }
  if (draft.steps.length > limits.maxSteps) {
    return {
      ok: false,
      message: `son ${draft.steps.length} pasos y el tope es ${limits.maxSteps}`,
      hint: 'junta los que se puedan hacer en una sola acción, o propón la primera mitad',
    };
  }
  if (draft.highestPermissionProfile === 'yolo') {
    return {
      ok: false,
      message: 'un sobre no puede firmar el perfil sin restricciones',
      hint: 'propón el workflow con `safe` o `auto`; lo que necesite más va con su propia tarjeta',
    };
  }

  const desconocidos = (draft.hosts ?? []).filter((host) => !limits.allowedHosts.includes(host));
  if (desconocidos.length > 0) {
    return {
      ok: false,
      message: `estas máquinas no están en la lista de la casa: ${desconocidos.join(', ')}`,
      hint: `las que hay son ${limits.allowedHosts.join(', ')}`,
    };
  }

  /*
   * Que el sobre escriba lo dicen dos cosas y basta con una: el perfil que pidió, o que algún paso
   * se haya declarado como que modifica. Se toma el máximo de las dos porque declarar poco y luego
   * escribir es la forma en que un perímetro se queda corto sin que nadie lo note.
   */
  const escribe = writes(draft.highestPermissionProfile)
    || draft.steps.some((step) => step.writes === true);

  return {
    ok: true,
    envelope: {
      hosts: [...new Set(draft.hosts ?? [])],
      maxSteps: draft.steps.length,
      maxRuns: Math.max(0, draft.maxRuns ?? draft.steps.length),
      highestPermissionProfile: draft.highestPermissionProfile,
      writes: escribe,
      capabilities: [...new Set(draft.capabilities ?? [])],
    },
  };
}

/**
 * La huella de lo que se firmó.
 *
 * Se calcula igual que la de cualquier otra aprobación —`sha256` del objetivo de la acción— para
 * que la maquinaria de tarjetas no tenga que saber que existen los workflows: mismo TTL, mismo uso
 * único, misma ruta. Lo único distinto es qué hay dentro.
 *
 * Las claves van ordenadas porque un digest que depende del orden en que se escribió un objeto es
 * un digest que cambia solo.
 */
export function digestOf(target: { planId: string; objective: string; envelope: WorkflowEnvelope }): string {
  const estable = {
    actionType: 'workflow',
    planId: target.planId,
    objective: target.objective,
    envelope: {
      hosts: [...target.envelope.hosts].sort(),
      maxSteps: target.envelope.maxSteps,
      maxRuns: target.envelope.maxRuns,
      highestPermissionProfile: target.envelope.highestPermissionProfile,
      writes: target.envelope.writes,
      capabilities: [...target.envelope.capabilities].sort(),
    },
  };
  return createHash('sha256').update(JSON.stringify(estable)).digest('hex');
}

/** Lo que un paso quiere hacer, en lo que le importa al perímetro. */
export interface IntendedAction {
  kind: 'run' | 'capability';
  /** Para un run: dónde y con qué permiso. */
  host?: string | null;
  permissionProfile?: PermissionProfile;
  /** Para una capacidad: su nombre cualificado. */
  capability?: string;
}

export interface EnvelopeUse {
  /** Pasos ya consumidos, sin contar el que se está decidiendo. */
  steps: number;
  /** Trabajos ya lanzados por este plan. */
  runs: number;
}

/**
 * Si esta acción se sale de lo firmado, y por qué.
 *
 * Devuelve `null` cuando cabe. Cuando no, devuelve **la frase que va a leer una persona**, no un
 * código: quien mire la tarjeta tiene que entender de un vistazo qué pidió el asistente y qué
 * autorizó él, y «FORBIDDEN» no explica nada.
 *
 * **Sin sobre no se comprueba nada**, y eso es deliberado: los planes que ya existían no tienen
 * perímetro firmado, así que aplicarles esto o pasaría todo —y entonces no comprueba— o bloquearía
 * todo. Lo que decide si hay comprobación es tener sobre, no ser un plan. Que no se «simplifique»
 * quitando esta rama.
 */
export function outsideEnvelope(
  envelope: WorkflowEnvelope | null,
  action: IntendedAction,
  used: EnvelopeUse,
): string | null {
  if (!envelope) return null;

  if (used.steps >= envelope.maxSteps) {
    return `esto sería el paso ${used.steps + 1} y lo que autorizaste fueron ${envelope.maxSteps}`;
  }

  if (action.kind === 'run') {
    const profile = action.permissionProfile ?? 'safe';
    if (LADDER.indexOf(profile) > LADDER.indexOf(envelope.highestPermissionProfile)) {
      return `esto pide permiso «${profile}» y lo que autorizaste fue «${envelope.highestPermissionProfile}»`;
    }
    if (writes(profile) && !envelope.writes) {
      return 'esto escribiría en una máquina y lo que autorizaste era sólo mirar';
    }
    if (used.runs >= envelope.maxRuns) {
      return `sería el trabajo ${used.runs + 1} y lo que autorizaste fueron ${envelope.maxRuns}`;
    }
    if (action.host && !envelope.hosts.includes(action.host)) {
      return envelope.hosts.length > 0
        ? `esto tocaría «${action.host}» y lo que autorizaste fue ${envelope.hosts.join(', ')}`
        : `esto tocaría «${action.host}» y no autorizaste ninguna máquina`;
    }
    return null;
  }

  const capability = action.capability ?? '';
  if (!envelope.capabilities.includes(capability)) {
    return envelope.capabilities.length > 0
      ? `esto usaría «${capability}» y lo que autorizaste fue ${envelope.capabilities.join(', ')}`
      : `esto usaría «${capability}» y no autorizaste ninguna capacidad`;
  }
  return null;
}

export type RevisionOp = 'replace' | 'insert_after' | 'drop';

export interface RevisionChange {
  op: RevisionOp;
  ordinal: number;
  title?: string;
  intent?: string;
  expects?: string;
  unknowns?: string[];
  writes?: boolean;
}

export type RevisionResult =
  | { ok: true; steps: DraftStep[] }
  | { ok: false; message: string; hint?: string };

/**
 * Aplica una corrección a los pasos que aún no han empezado.
 *
 * Lo completado es historia y no se reescribe. No es una regla de prudencia: el paso hecho tiene un
 * `output` del que cuelga el siguiente y un run con su evidencia, así que cambiarlo no cambiaría lo
 * que pasó, sólo lo que el plan dice que pasó. Un plan que puede reescribir su pasado no sirve para
 * responder «qué se hizo aquí».
 *
 * Devuelve los pasos pendientes ya corregidos; los hechos se quedan donde están y el llamante los
 * conserva.
 */
export function applyRevision(
  steps: readonly PlanStep[],
  currentStep: number,
  changes: readonly RevisionChange[],
): RevisionResult {
  if (changes.length === 0) {
    return { ok: false, message: 'una revisión sin cambios no es una revisión' };
  }

  const pendientes = steps.filter((step) => step.ordinal >= currentStep);
  const tocados = changes.map((change) => change.ordinal);
  const historia = tocados.filter((ordinal) => ordinal < currentStep);
  if (historia.length > 0) {
    return {
      ok: false,
      message: `los pasos ${historia.join(', ')} ya se hicieron y no se reescriben`,
      hint: 'corrige los que quedan por delante, o propón un workflow nuevo si hay que deshacer algo',
    };
  }

  const comoBorrador = (step: PlanStep): DraftStep => {
    const input = (step.input ?? {}) as Partial<DraftStep>;
    return {
      title: step.title,
      intent: input.intent ?? '',
      expects: input.expects ?? '',
      unknowns: input.unknowns ?? [],
      writes: input.writes ?? false,
    };
  };

  let resultado = pendientes.map(comoBorrador);
  for (const change of changes) {
    const indice = pendientes.findIndex((step) => step.ordinal === change.ordinal);
    if (indice < 0) {
      return { ok: false, message: `no hay ningún paso pendiente con ordinal ${change.ordinal}` };
    }
    if (change.op === 'drop') {
      resultado = resultado.filter((_, i) => i !== indice);
      continue;
    }
    const nuevo: DraftStep = {
      title: change.title ?? resultado[indice]?.title ?? '',
      intent: change.intent ?? resultado[indice]?.intent ?? '',
      expects: change.expects ?? resultado[indice]?.expects ?? '',
      unknowns: change.unknowns ?? resultado[indice]?.unknowns ?? [],
      writes: change.writes ?? resultado[indice]?.writes ?? false,
    };
    if (change.op === 'replace') resultado[indice] = nuevo;
    else resultado.splice(indice + 1, 0, nuevo);
  }

  if (resultado.length === 0) {
    return {
      ok: false,
      message: 'una revisión no puede dejar el workflow sin pasos',
      hint: 'si ya no hay nada que hacer, ciérralo con finish en vez de vaciarlo',
    };
  }
  return { ok: true, steps: resultado };
}

/**
 * Si la corrección se sale de lo que se firmó.
 *
 * Un workflow puede corregirse dentro de su perímetro sin volver a preguntar —para eso se firmó el
 * perímetro y no la lista— pero una revisión que **ensancha** el perímetro es otra cosa: pedir más
 * pasos, tocar más máquinas o pasar a escribir no es corregir un plan, es proponer otro.
 */
export function revisionOutsideEnvelope(
  envelope: WorkflowEnvelope | null,
  steps: readonly DraftStep[],
): string | null {
  if (!envelope) return null;
  if (steps.length > envelope.maxSteps) {
    return `la revisión deja ${steps.length} pasos y lo que autorizaste fueron ${envelope.maxSteps}`;
  }
  if (!envelope.writes && steps.some((step) => step.writes === true)) {
    return 'la revisión añade un paso que escribiría en una máquina, y lo que autorizaste era sólo mirar';
  }
  return null;
}
