/**
 * El vocabulario del Assistant: lo que el core le enseña al modelo y lo que le acepta de vuelta.
 *
 * Está aparte del modelo y del adaptador de herramientas a propósito. El modelo cambia (hoy
 * Anthropic, mañana otro), el adaptador cambia cuando aparece un caso de uso nuevo, pero el
 * contrato entre ambos —qué se ve, qué se puede decidir— es lo que hace que un plan sea
 * reproducible y auditable. Si esto se mueve, se rompe el histórico.
 */
import type { ChatRef, ModelSource, PermissionProfile, Provider } from '@jarvis/contracts';

/** Lo que el modelo ve de un paso ya ocurrido. Resúmenes y referencias, nunca buffers. */
export interface PlanHistoryEntry {
  ordinal: number;
  kind: string;
  title: string;
  status: string;
  summary: string | null;
  /** La evidencia se cita por id: el contenido se consulta con `get_run` si hace falta. */
  runId: string | null;
  errorCode: string | null;
}

/**
 * El paquete de contexto (05 §10.3).
 *
 * Lo que **no** lleva es tan importante como lo que lleva: ni transcripts enteros, ni la salida
 * de los runs, ni el prompt original repetido. Todo eso se pide con una herramienta, acotado, y
 * sólo cuando el modelo decide que lo necesita.
 */
export interface PlanContext {
  objective: string;
  /**
   * La sesión sobre la que se trabaja, si la hay.
   *
   * Un plan siempre tiene una. Una conversación puede no tenerla —«¿cómo va el servidor?» no exige
   * haber abierto nada—, y entonces el contexto lo dice en vez de inventarse un workspace vacío,
   * que es lo que haría que el modelo hablase de una sesión que no existe.
   */
  workspace?: {
    id: string;
    host: string;
    provider: Provider;
    sessionId: string;
    cwd: string | null;
    title: string | null;
  };
  history: PlanHistoryEntry[];
  /**
   * El hilo, cuando esto es una conversación y no un plan.
   *
   * Va aparte del historial de pasos a propósito: son dos formas distintas de contarle al modelo
   * lo que ya pasó, y mezclarlas produce un prompt que no es ni una cosa ni la otra. Un plan
   * enseña checkpoints —«[run/completed] Reunir contexto»—; una conversación enseña lo que se
   * dijo. A un modelo de 1,7B lo segundo le rinde bastante más.
   */
  messages?: Array<{ role: 'user' | 'assistant' | 'tool'; text: string }>;
  /**
   * Las capacidades que puede usar sin buscarlas.
   *
   * Van **en el contexto** y no detrás de una consulta porque cada ida y vuelta con el modelo de
   * casa cuesta entre diez y veinte segundos. Medido: la pregunta más común de esta casa —cómo va
   * la memoria— se resolvía en cinco llamadas al modelo porque la primera se iba en preguntar qué
   * herramientas había. Con esto puestas, son dos. Cuestan unos 580 tokens y ahorran dos viajes.
   */
  capabilities?: Array<{ name: string; summary: string; params: string }>;
  /**
   * Lo que ya se encontró en este hilo.
   *
   * Es lo que permite decir «esa sesión» en el turno siguiente sin volver a buscarla. Se
   * reconstruye de las referencias guardadas, que son datos tipados, y no leyendo el eco recortado
   * de las herramientas, que es texto y se rompe. En la conversación medida, cinco de veinticinco
   * consultas fueron la misma búsqueda repetida.
   */
  found?: Array<{ host: string; provider: Provider; sessionId: string; title: string | null; workspaceId: string | null }>;
  /**
   * Qué hay abierto y qué está corriendo ahora mismo.
   *
   * Va en el contexto y no en una herramienta porque cuesta unas cien palabras y una vuelta contra
   * el modelo cuesta mucho más: quita la razón más común para gastar una consulta. Sólo aparece si
   * hay algo.
   *
   * **No lleva salud a propósito.** Lo que hay abierto son sustantivos —una sesión, un trabajo—;
   * un salto en rojo es un problema, y poner un problema delante convierte un «Hola» en un
   * diagnóstico. Ya pasó una vez con las capacidades de arranque y se midió: tres de tres. Para la
   * salud está `get_health`, y el acceso directo desde la pantalla de Salud, que es quien sí sabe
   * que la pregunta va de eso.
   */
  house?: {
    workspaces: Array<{ id: string; title: string | null; host: string; provider: Provider }>;
    runs: Array<{ runId: string; status: string; title: string | null }>;
  };
  /** Lo que dijo la persona cuando se le preguntó algo, sin usar todavía. */
  pendingInput: string | null;
  /** Aprobaciones vivas de este plan: pedir otra vez lo ya pedido es ruido. */
  pendingApprovals: Array<{ id: string; summary: string; expiresAt: string }>;
  /**
   * Con qué cerebro se pide este turno.
   *
   * `cloud` sólo llega aquí detrás de una escalada que una persona ya autorizó; por defecto se
   * piensa en casa. Va en el contexto y no en la configuración del modelo porque es un dato **del
   * turno**: el mismo plan puede tener un paso pensado localmente y el siguiente en la nube, y el
   * historial tiene que poder decir cuál fue cuál.
   */
  source?: ModelSource;
  /** Los límites se dicen, no se descubren fallando. */
  limits: {
    stepsUsed: number;
    maxSteps: number;
    maxToolCalls: number;
    maxToolOutputBytes: number;
  };
}

/**
 * Una oferta de terminal. El Assistant **ofrece**; abrir la terminal es un gesto de la persona.
 *
 * Por eso esto es un dato que viaja al plan y de ahí a la interfaz, y no una llamada que levante
 * una tmux por su cuenta: nadie quiere descubrir que su coordinador abrió sesiones vivas mientras
 * no miraba.
 */
export interface TerminalOffer {
  host: string;
  provider: Provider;
  sessionId: string;
  cwd: string | null;
  permissionProfile: PermissionProfile;
  reason: string;
}

/** Un run citado por la síntesis: el enlace a la evidencia, no su copia. */
export interface EvidenceRef {
  runId: string;
  title: string;
  status: string;
  summary: string | null;
}

/**
 * Lo que el core sabe ejecutar cuando el modelo termina su turno.
 *
 * Cada variante es un checkpoint: se persiste antes del efecto y su clave de idempotencia decide,
 * tras un reinicio, si hay que observar lo que ya pasó o ejecutar algo nuevo.
 */
export type AssistantDecision =
  | { kind: 'run'; title: string; prompt: string; permissionProfile: PermissionProfile; rationale: string }
  | { kind: 'approval'; title: string; actionType: string; summary: string; permissionProfile: PermissionProfile; prompt: string }
  | { kind: 'ask'; title: string; question: string }
  /**
   * Ejecutar una capacidad MCP con efectos, previa aprobación (ADR-009).
   *
   * Sólo la produce la conversación, porque es la única que sabe ejecutarla: el motor de planes
   * únicamente sabe lanzar runs, y una aprobación que no se puede cumplir es una promesa rota con
   * pasos de por medio.
   */
  | { kind: 'capability'; title: string; capability: string; args: Record<string, unknown>; summary: string }
  /**
   * Salir al modelo de la nube.
   *
   * El modelo local lo pide; la persona lo concede. Nunca se escala solo: el coste y la privacidad
   * de mandar el contexto fuera de casa no son decisiones del modelo que se está quedando corto.
   */
  | { kind: 'escalate'; reason: string }
  | { kind: 'finish'; summary: string; evidenceRunIds?: string[] };

/** Esquema JSON de la entrada de una herramienta, tal como lo espera la API del modelo. */
export interface ToolInputSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
  /**
   * Una herramienta que decide cierra el turno: devuelve el checkpoint que el core persiste y la
   * llamada al modelo termina ahí. Las demás son lecturas cortas que se resuelven en el momento.
   */
  decides: boolean;
}

export type ToolOutcome =
  | { type: 'observation'; content: unknown }
  | { type: 'decision'; decision: AssistantDecision };

/**
 * El adaptador de herramientas.
 *
 * Las herramientas llaman a los casos de uso del core —los mismos que usa REST—, nunca a la API
 * HTTP ni a una lógica paralela. Un camino, una semántica, una auditoría.
 */
export interface AssistantToolbox {
  definitions(options?: { decisionsOnly?: boolean }): ToolDefinition[];
  invoke(name: string, input: Record<string, unknown>): Promise<ToolOutcome>;
  /** La oferta de terminal que el modelo dejó preparada en este turno, si dejó alguna. */
  readonly terminalOffer: TerminalOffer | null;
  /**
   * Lo que el turno dejó pulsable: workspaces abiertos, terminales ofrecidas, sesiones encontradas.
   *
   * Es lo que convierte un hallazgo en un botón. Sin esto el asistente encuentra una sesión y a
   * «ábremela» sólo sabe contestar dónde está.
   */
  readonly refs: ChatRef[];
  /**
   * Cuántas veces pidió en este turno algo que ya había preguntado.
   *
   * No se cuenta por curiosidad: es lo único que deja ver una repetición que no llegó a ejecutarse
   * y que, por lo mismo, no deja rastro en el hilo. Sin este número, arreglar el bucle y esconderlo
   * se parecen demasiado.
   */
  readonly repeats: number;
  /** Cuántas lecturas lleva el turno: el presupuesto es del core, no del modelo. */
  readonly observations: number;
  /**
   * Si ya no queda presupuesto —por número de consultas o por reloj—.
   *
   * El modelo lo consulta para dejar de ofrecerle herramientas de lectura en cuanto se agota. Sin
   * esto se le siguen ofreciendo, las pide, se le contesta que no queda, y **cada uno de esos
   * rechazos cuesta una vuelta entera contra el modelo**: en el de casa, dos minutos por saber
   * algo que el core ya sabía.
   */
  readonly spent: boolean;
}

export interface AssistantModel {
  readonly id: string;
  /**
   * Una decisión por turno. El modelo puede leer lo que necesite con el toolbox, pero no se
   * queda esperando: cuando hay que aguardar a algo, devuelve el checkpoint y se va a casa.
   */
  decide(context: PlanContext, toolbox: AssistantToolbox): Promise<AssistantDecision>;
}
