/**
 * La conversación con el asistente local.
 *
 * No es un plan y no finge serlo. Un plan es una lista de pasos con checkpoint que sobrevive
 * horas esperando a un run; una conversación es un ida y vuelta que se lee de arriba abajo. Lo
 * que comparten es lo que importa —las mismas herramientas, las mismas aprobaciones, la misma
 * auditoría— y por eso una conversación puede **crear** un plan, pero no es uno.
 *
 * Una conversación puede no tener workspace: preguntarle a la máquina cómo está no exige haber
 * abierto antes una sesión de agente. Con workspace, además, alcanza el trabajo de ese workspace.
 */
import { Type, type Static } from '@sinclair/typebox';
import { HostName, Iso8601, Provider } from './common.js';

/**
 * Cuánta cuerda tiene el asistente sin preguntar.
 *
 * Es una decisión de la persona y va en la conversación, no en la configuración del servidor: la
 * misma casa quiere un asistente suelto para diagnosticar y otro atado para tocar producción, y
 * quien sabe cuál toca es quien está escribiendo.
 *
 * `manual` — todo lo que tenga efectos se pregunta, incluido lanzar un trabajo en perfil seguro.
 * `auto`   — el trabajo en perfil seguro y las lecturas van solos. Siguen preguntando, siempre:
 *            escribir en una máquina, los perfiles `auto` y `yolo`, parar trabajo que lanzó una
 *            persona, y salir a la nube.
 *
 * Que `auto` sea más laxo no lo hace ilimitado: las excepciones de arriba no se pueden apagar
 * desde la interfaz, porque son las que separan «que trabaje solo» de «que decida solo».
 */
export const AUTONOMY_MODES = ['manual', 'auto'] as const;
export type AutonomyMode = (typeof AUTONOMY_MODES)[number];
export const AutonomyModeSchema = Type.Union(AUTONOMY_MODES.map((mode) => Type.Literal(mode)));

/** De qué cerebro salió cada cosa. Se guarda por mensaje: una conversación puede mezclar. */
export const MODEL_SOURCES = ['local', 'cloud'] as const;
export type ModelSource = (typeof MODEL_SOURCES)[number];
export const ModelSourceSchema = Type.Union(MODEL_SOURCES.map((source) => Type.Literal(source)));

/**
 * Algo que el asistente encontró y sobre lo que se puede actuar.
 *
 * Existe porque sin esto el asistente **encuentra cosas y no puede hacer nada con ellas**: localizó
 * una sesión y a «ábremela» sólo supo contestar dónde estaba. Una referencia es lo que convierte
 * un hallazgo en un botón.
 *
 * No es una acción ejecutada: es una acción **ofrecida**. Abrir un workspace sí lo hace el
 * asistente —es un marcador y no toca ninguna máquina— pero una terminal viva levanta una tmux en
 * un servidor, y ésa la abre una persona. La misma regla de siempre.
 */
export const ChatRef = Type.Union([
  Type.Object({
    kind: Type.Literal('workspace'),
    workspaceId: Type.String(),
    title: Type.Union([Type.String(), Type.Null()]),
  }),
  Type.Object({
    kind: Type.Literal('session'),
    host: HostName,
    provider: Provider,
    sessionId: Type.String(),
    title: Type.Union([Type.String(), Type.Null()]),
    /**
     * Su directorio de trabajo, si el índice lo sabía.
     *
     * Va aquí y no se busca otra vez porque es lo único que sobrevive al turno: el toolbox se
     * construye uno por turno, así que lo que `search_sessions` dijo en el primero se ha perdido
     * cuando en el tercero se pide una terminal. Sin esto la terminal arranca en el home.
     */
    cwd: Type.Union([Type.String(), Type.Null()]),
  }),
  Type.Object({
    kind: Type.Literal('terminal'),
    host: HostName,
    provider: Provider,
    sessionId: Type.String(),
    /** Sin él, la terminal arranca en el home: el core resuelve el `cwd` a partir del workspace. */
    workspaceId: Type.Union([Type.String(), Type.Null()]),
    cwd: Type.Union([Type.String(), Type.Null()]),
    /** Por qué conviene mirarlo en vivo. Una oferta sin motivo no se entiende y no se pulsa. */
    reason: Type.String(),
  }),
  Type.Object({
    kind: Type.Literal('run'),
    runId: Type.String(),
    title: Type.Union([Type.String(), Type.Null()]),
  }),
]);
export type ChatRef = Static<typeof ChatRef>;

export const CHAT_ROLES = ['user', 'assistant', 'tool', 'event'] as const;
export type ChatRole = (typeof CHAT_ROLES)[number];

export const CONVERSATION_STATUSES = ['idle', 'thinking', 'waiting_approval', 'failed'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

/**
 * Un mensaje.
 *
 * `seq` es identidad pública dentro de la conversación y no se reutiliza jamás: es lo que hace
 * que reconectar el stream con `Last-Event-ID` devuelva exactamente lo que falta y ni un mensaje
 * más. Igual que el `seq` de los eventos de run, y por el mismo motivo.
 */
export const ChatMessage = Type.Object({
  id: Type.String(),
  conversationId: Type.String(),
  seq: Type.Integer({ minimum: 0 }),
  role: Type.Union(CHAT_ROLES.map((role) => Type.Literal(role))),
  text: Type.String(),
  /** Para `role: 'tool'`: qué se llamó, con qué y qué contestó, ya acotado. */
  toolName: Type.Union([Type.String(), Type.Null()]),
  toolInput: Type.Union([Type.Unknown(), Type.Null()]),
  toolOk: Type.Union([Type.Boolean(), Type.Null()]),
  /** Qué modelo produjo esto, y si fue el de casa o el de fuera. */
  source: Type.Union([ModelSourceSchema, Type.Null()]),
  modelId: Type.Union([Type.String(), Type.Null()]),
  /** Una aprobación pendiente atada a este mensaje: escalar, escribir, o lanzar trabajo. */
  approvalId: Type.Union([Type.String(), Type.Null()]),
  /**
   * Trabajos citados. **Heredado**: lo nuevo va en `refs`.
   *
   * Se queda porque las filas escritas antes de que existieran las referencias lo usan, y migrar
   * datos por uniformidad no compensa. La interfaz pinta los dos.
   */
  runIds: Type.Array(Type.String()),
  /** Lo que se puede pulsar de este mensaje: workspaces, sesiones, terminales ofrecidas, trabajos. */
  refs: Type.Array(ChatRef),
  createdAt: Iso8601,
});
export type ChatMessage = Static<typeof ChatMessage>;

export const Conversation = Type.Object({
  id: Type.String(),
  title: Type.String(),
  createdBy: Type.String(),
  /** Sin workspace la conversación es sobre la casa; con él, alcanza el trabajo de ese workspace. */
  workspaceId: Type.Union([Type.String(), Type.Null()]),
  autonomy: AutonomyModeSchema,
  status: Type.Union(CONVERSATION_STATUSES.map((status) => Type.Literal(status))),
  /** Con qué cerebro se está hablando ahora mismo. La escalada lo cambia para un turno. */
  source: ModelSourceSchema,
  messageCount: Type.Integer({ minimum: 0 }),
  createdAt: Iso8601,
  updatedAt: Iso8601,
  lastMessageAt: Type.Union([Iso8601, Type.Null()]),
});
export type Conversation = Static<typeof Conversation>;

/** Lo que la interfaz necesita saber para no ofrecer lo que no existe. */
export const ChatCapabilities = Type.Object({
  /** Hay cerebro local configurado y responde. */
  localAvailable: Type.Boolean(),
  localModel: Type.Union([Type.String(), Type.Null()]),
  /** Hay a dónde escalar. Si no, la interfaz no promete una salida que no existe. */
  cloudAvailable: Type.Boolean(),
  cloudModel: Type.Union([Type.String(), Type.Null()]),
  /** Cuántas capacidades MCP hay enchufadas, para enseñarlo sin pedir el catálogo. */
  capabilityCount: Type.Integer({ minimum: 0 }),
  /**
   * Cómo se le ofrecen al modelo.
   *
   * `direct` — cada capacidad es una herramienta suya: elige a la primera y no puede inventarse un
   * nombre, porque la API sólo acepta los declarados.
   * `router` — no caben en el tope de 128 funciones y hay que buscarlas antes de usarlas, lo que
   * cuesta una vuelta más por consulta.
   *
   * Se dice porque el repliegue es silencioso: un servidor MCP que crece unas cuantas herramientas
   * cambia el modo de todas las conversaciones sin que nadie toque nada, y sin este campo eso sólo
   * se nota por el asistente yendo más lento.
   */
  capabilityMode: Type.Union([Type.Literal('direct'), Type.Literal('router')]),
  /** Cuántas capacidades más caben antes de caer al router. */
  capabilityRoom: Type.Integer({ minimum: 0 }),
});
export type ChatCapabilities = Static<typeof ChatCapabilities>;
