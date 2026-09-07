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
import { ArtifactKindSchema, ArtifactPresentationSchema } from './artifacts.js';
import { HostName, Iso8601, Provider } from './common.js';

/**
 * Cuánta cuerda tiene el asistente sin preguntar.
 *
 * Es una decisión de la persona y va en la conversación, no en la configuración del servidor: la
 * misma casa quiere un asistente suelto para diagnosticar y otro atado para tocar producción, y
 * quien sabe cuál toca es quien está escribiendo.
 *
 * `manual`       — todo lo que tenga efectos se pregunta, incluido lanzar un trabajo en perfil seguro.
 * `auto`         — el perfil seguro y las lecturas van solos. Escribir en una máquina sigue
 *                  pidiendo tarjeta, y las capacidades con efectos también.
 * `unrestricted` — «Sin preguntar» en la interfaz, y no «sin restricciones», que es la etiqueta del
 *                  perfil `yolo` y nombra el otro eje: uno dice qué permiso lleva el trabajo y el
 *                  otro cuánta cuerda hay sin firma.
 *                  Además va solo el trabajo en perfil de escritura y la capacidad **etiquetada**
 *                  con efectos. Se relaja lo conocido, nunca lo desconocido: una capacidad sin
 *                  etiquetar, cuyo efecto se infiere, sigue pidiendo tarjeta.
 *
 * Lo que no abre ningún modo, y no se puede apagar desde la interfaz: el perfil `yolo`, salir a la
 * nube, parar trabajo que lanzó una persona, y las que nunca se ejecutan (apagar o reiniciar el
 * bastión, instalar paquetes). Son las que separan «que trabaje solo» de «que decida solo».
 *
 * `unrestricted` además exige `JARVIS_ALLOW_UNRESTRICTED` en el servidor: una decisión que amplía
 * lo que una máquina hace sola no puede vivir sólo detrás de un botón de la pantalla. Ver ADR-010.
 */
export const AUTONOMY_MODES = ['manual', 'auto', 'unrestricted'] as const;
export type AutonomyMode = (typeof AUTONOMY_MODES)[number];
export const AutonomyModeSchema = Type.Union(AUTONOMY_MODES.map((mode) => Type.Literal(mode)));

/**
 * La autonomía de un valor cualquiera, cayendo al modo que **más pregunta**.
 *
 * Vive aquí y no en cada sitio que la necesita porque hay tres —la configuración, la fila de una
 * conversación y la de un plan— y con tres copias basta con que una se olvide de validar para que
 * una errata conceda permisos. `'Manual'` con mayúscula, `'automatico'` o un valor viejo de una
 * migración no son «manual» para un `===`, y el gate estaba escrito en positivo: lo que no era
 * exactamente `manual` ni `auto` **no preguntaba**.
 */
export const autonomyOf = (value: unknown): AutonomyMode =>
  ((AUTONOMY_MODES as readonly string[]).includes(String(value)) ? value : 'manual') as AutonomyMode;

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
  /**
   * Contenido con forma que el asistente dejó colgado de la respuesta.
   *
   * Es **el puntero, no el contenido**: el cuerpo vive en su propia tabla y se pide aparte. Va
   * aquí porque los últimos mensajes del hilo son también el contexto que se le pasa al modelo en
   * cada turno, y una tabla de doscientas filas metida en la fila del mensaje se paga en tokens
   * mientras dure la conversación.
   *
   * Y no comparte cupo con las demás referencias: las otras cuatro son botones —un mensaje con
   * doce debajo es ruido— y esto es contenido. Meterlos en el mismo tope hace que un informe se
   * coma la oferta de terminal.
   */
  Type.Object({
    kind: Type.Literal('artifact'),
    artifactId: Type.String(),
    artifactKind: ArtifactKindSchema,
    presentation: ArtifactPresentationSchema,
    title: Type.String(),
    bytes: Type.Integer({ minimum: 0 }),
    /** Lo justo para pintar el chip sin pedir el cuerpo: la primera línea, o nada. */
    preview: Type.Union([Type.String(), Type.Null()]),
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
  /**
   * Quién habló el último.
   *
   * Va el rol y no un «sin contestar» calculado: un booleano fija en el contrato una regla que
   * mañana puede cambiar, y el rol es un hecho que sigue valiendo aunque la regla cambie. Con él,
   * la lista puede enseñar **antes de entrar** que una pregunta se quedó sin respuesta — hoy eso
   * sólo se sabe abriendo la conversación, y quien no la abre no se entera nunca.
   */
  lastMessageRole: Type.Union([Type.Union(CHAT_ROLES.map((role) => Type.Literal(role))), Type.Null()]),
  /**
   * Si la última pregunta de la persona se quedó sin respuesta.
   *
   * Definido como **no hay ningún mensaje del asistente después del último de la persona**, y eso
   * es un hecho sobre el hilo, no una regla sobre roles: sigue significando lo mismo aunque
   * mañana cambien los estados, los eventos o quién escribe qué.
   *
   * Hacía falta porque `lastMessageRole` no basta: `event` lo escriben diecisiete sitios distintos
   * y dicen cosas opuestas —«me quedé sin intentos» y «plan corregido», que es un turno que acabó
   * bien—. Deducir la avería del rol marcaría un plan corregido como pregunta perdida. Aquí no hay
   * nada que deducir: o hay respuesta después de la pregunta, o no la hay.
   */
  pendingAnswer: Type.Boolean(),
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
  /**
   * Lo que ocupa el catálogo que se le declara al modelo **en cada vuelta**, en bytes.
   *
   * `capabilityCount` y `capabilityRoom` cuentan funciones, que es lo que decide el repliegue al
   * router porque el tope de la API es de cuenta. Pero desde que cada definición lleva su esquema y
   * su descripción larga, la presión se ha ido a otro sitio: las mismas 108 capacidades cuestan más
   * por vuelta y ninguna de las dos cifras lo dice.
   *
   * Van bytes y no tokens porque los bytes se miden y los tokens se estiman. Cuatro por token es
   * una regla razonable para leerlo, y una regla no es un dato.
   */
  catalogBytes: Type.Integer({ minimum: 0 }),
  /**
   * Qué modos de autonomía puede ofrecer la interfaz.
   *
   * No es la lista entera de `AUTONOMY_MODES`: `unrestricted` sólo aparece si el servidor lo
   * permite. La pantalla no debe ofrecer un modo que la ruta va a rechazar.
   */
  autonomyModes: Type.Array(AutonomyModeSchema),
});
export type ChatCapabilities = Static<typeof ChatCapabilities>;
