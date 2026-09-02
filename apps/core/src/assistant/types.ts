/**
 * El vocabulario del Assistant: lo que el core le enseña al modelo y lo que le acepta de vuelta.
 *
 * Está aparte del modelo y del adaptador de herramientas a propósito. El modelo cambia (hoy
 * Anthropic, mañana otro), el adaptador cambia cuando aparece un caso de uso nuevo, pero el
 * contrato entre ambos —qué se ve, qué se puede decidir— es lo que hace que un plan sea
 * reproducible y auditable. Si esto se mueve, se rompe el histórico.
 */
import type { PermissionProfile, Provider } from '@jarvis/contracts';

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
  workspace: {
    id: string;
    host: string;
    provider: Provider;
    sessionId: string;
    cwd: string | null;
    title: string | null;
  };
  history: PlanHistoryEntry[];
  /** Lo que dijo la persona cuando se le preguntó algo, sin usar todavía. */
  pendingInput: string | null;
  /** Aprobaciones vivas de este plan: pedir otra vez lo ya pedido es ruido. */
  pendingApprovals: Array<{ id: string; summary: string; expiresAt: string }>;
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
  /** Cuántas lecturas lleva el turno: el presupuesto es del core, no del modelo. */
  readonly observations: number;
}

export interface AssistantModel {
  readonly id: string;
  /**
   * Una decisión por turno. El modelo puede leer lo que necesite con el toolbox, pero no se
   * queda esperando: cuando hay que aguardar a algo, devuelve el checkpoint y se va a casa.
   */
  decide(context: PlanContext, toolbox: AssistantToolbox): Promise<AssistantDecision>;
}
