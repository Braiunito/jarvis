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
import { Iso8601 } from './common.js';

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
  /** Trabajos citados. Como en la síntesis de un plan: la referencia, nunca la copia. */
  runIds: Type.Array(Type.String()),
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
});
export type ChatCapabilities = Static<typeof ChatCapabilities>;
