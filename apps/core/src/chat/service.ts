/**
 * La conversación: el asistente de casa, con la puerta a la nube cerrada por defecto.
 *
 * Un turno es corto y todo lo que produce se **escribe según ocurre**. No hay una respuesta que se
 * compone en memoria y aparece entera al final: el mensaje de la persona, cada consulta a una
 * herramienta, su resultado y la respuesta van a SQLite en cuanto pasan, y el stream SSE es una
 * proyección de lo escrito. Recargar la página a mitad de un turno no pierde nada, y reiniciar el
 * core tampoco: lo que se ve es lo que hay en la base.
 *
 * Por qué se emite por mensajes y no token a token, que sería más vistoso: el modelo tiene que
 * llamar a herramientas, y para leer una llamada a herramienta hay que esperar a que el mensaje
 * esté completo. Emitir «consultando memory_pressure…» en cuanto ocurre da la sensación de avance
 * que hace falta a 7 tokens por segundo, sin montar un parser incremental de `tool_calls` que se
 * rompería con cada cambio de plantilla del modelo.
 *
 * Tres cosas nunca ocurren solas aquí, y las tres son la misma regla —lo que tiene consecuencias
 * lo decide una persona—: tocar una máquina, lanzar trabajo en autonomía `manual`, y salir a la
 * nube. Las tres pasan por la misma tarjeta de aprobación, con su digest y su caducidad.
 */
import { createHash } from 'node:crypto';
import type { Database as Db } from 'better-sqlite3';
import type {
  Approval, AutonomyMode, ChatCapabilities, ChatMessage, ChatRef, Conversation, ModelSource,
  UserIdentity,
} from '@jarvis/contracts';
import { isTerminalStatus, JarvisError } from '@jarvis/contracts';
import type { Clock } from '../platform/clock.js';
import { newApprovalId } from '../platform/ids.js';
import type { AuditLog } from '../platform/audit.js';
import type { AttachmentService } from '../attachments/service.js';
import type { EvidenceService } from '../evidence/service.js';
import type { RunService } from '../runs/service.js';
import type { SessionService } from '../sessions/service.js';
import type { HealthService } from '../health/service.js';
import type { WorkspaceService } from '../workspaces/use-cases.js';
import type { McpService } from '../mcp/service.js';
import type { HybridModel } from '../assistant/hybrid.js';
import type {
  AssistantDecision, AssistantToolbox, PlanContext, ToolDefinition, ToolOutcome,
} from '../assistant/types.js';
import {
  CoreAssistantToolbox, directCapacity, type SeenSession, type ToolboxLimits,
} from '../assistant/toolbox.js';
import { ChatRepository } from './repository.js';
import { ChatEventBus } from './events-bus.js';

/** Lo que se guarda de un resultado de herramienta en el hilo. Lo completo ya está en su sitio. */
const TOOL_ECHO_CHARS = 1200;
const TITLE_CHARS = 60;

export interface ChatServiceDeps {
  db: Db;
  clock: Clock;
  runs: RunService;
  workspaces: WorkspaceService;
  sessions: SessionService;
  health: HealthService;
  audit: AuditLog;
  /** Sin modelo no hay conversación, y la interfaz lo dice en vez de fallar al enviar. */
  model: HybridModel | null;
  mcp?: McpService;
  attachments?: AttachmentService;
  evidence?: EvidenceService;
  maxToolCalls?: number;
  historyMessages?: number;
  defaultAutonomy?: AutonomyMode;
  /**
   * Cuánto puede pasar un turno consultando antes de tener que responder.
   *
   * Es el tope que de verdad protege a quien está esperando delante de la pantalla: contar
   * consultas no acota nada cuando cada una cuesta dos minutos. Pasado el plazo el turno no se
   * corta —eso perdería lo que ya sabe— sino que deja de ofrecerle lecturas y le pide que
   * responda con lo que tenga.
   */
  maxTurnMs?: number;
  approvalTtlMs?: number;
  starterCapabilities?: readonly string[];
  /**
   * Ofrecer el catálogo MCP como herramientas propias en vez de detrás del router.
   *
   * Con un modelo capaz es mejor: elige a la primera y **no puede inventarse un nombre**, porque
   * la API sólo acepta los que se le declararon. Con uno pequeño era imposible —el catálogo no le
   * cabía en el contexto— y de ahí viene el router, que sigue ahí para cuando no quepa.
   */
  directCapabilities?: boolean;
  maxTools?: number;
  toolLimits?: Partial<ToolboxLimits>;
}

export class ChatService {
  readonly #deps: ChatServiceDeps;
  readonly #repository: ChatRepository;
  readonly #maxToolCalls: number;
  readonly #historyMessages: number;
  readonly #defaultAutonomy: AutonomyMode;
  readonly #approvalTtlMs: number;
  readonly #maxTurnMs: number;
  readonly bus = new ChatEventBus();
  /**
   * Turnos en curso, por conversación.
   *
   * Se serializan por el mismo motivo que los de un plan: dos turnos a la vez ven el mismo
   * historial, los dos contestan, y el hilo acaba con dos respuestas a una pregunta. Aquí es
   * todavía más fácil de provocar, porque basta con que alguien pulse Enviar dos veces.
   */
  readonly #turns = new Map<string, Promise<void>>();

  constructor(deps: ChatServiceDeps) {
    this.#deps = deps;
    this.#repository = new ChatRepository({ db: deps.db, clock: deps.clock });
    this.#maxToolCalls = deps.maxToolCalls ?? 8;
    this.#historyMessages = deps.historyMessages ?? 12;
    this.#defaultAutonomy = deps.defaultAutonomy ?? 'manual';
    this.#approvalTtlMs = deps.approvalTtlMs ?? 30 * 60 * 1000;
    this.#maxTurnMs = deps.maxTurnMs ?? 120_000;
  }

  /**
   * Deja en pie las conversaciones que se quedaron pensando.
   *
   * Un turno vive en memoria: si el proceso muere a mitad —un despliegue, un reinicio, un fallo—
   * la fila se queda en `thinking` y **no vuelve sola nunca**. La pantalla dice «pensando…» para
   * siempre y quien mira no tiene forma de saber que ya no hay nadie pensando. Pasó en producción
   * el primer día.
   *
   * No se reanuda el turno: se cierra diciendo lo que ocurrió. Reanudarlo exigiría saber en qué
   * punto estaba, y lo que había en ese punto era una llamada a un modelo que ya no existe. Lo
   * honesto es devolver la conversación a la persona, que puede volver a preguntar sabiendo qué
   * pasó.
   */
  reconcile(): number {
    const stuck = this.#deps.db
      .prepare("SELECT id FROM conversations WHERE status = 'thinking'")
      .all() as Array<{ id: string }>;
    for (const { id } of stuck) {
      this.#repository.append(id, {
        role: 'event',
        text: 'El servidor se reinició mientras el asistente pensaba, así que ese turno se perdió. '
          + 'Vuelve a preguntar cuando quieras.',
      });
      this.#repository.setStatus(id, 'idle', 'local');
    }
    return stuck.length;
  }

  // ---- consulta -----------------------------------------------------------

  /** Lo que la interfaz necesita para no ofrecer lo que no existe. */
  async capabilities(): Promise<ChatCapabilities> {
    const model = this.#deps.model;
    const count = this.#deps.mcp?.configured ? await this.#deps.mcp.count().catch(() => 0) : 0;
    /*
     * El cupo del caso peor: con workspace, que es cuando menos sitio queda.
     *
     * La pantalla es una y las conversaciones son muchas; decir el cupo de la más holgada sería
     * prometer un modo que la siguiente conversación no va a tener.
     */
    const room = directCapacity({
      ...(this.#deps.maxTools ? { maxTools: this.#deps.maxTools } : {}),
      scoped: true,
      capabilityWrites: Boolean(this.#deps.mcp?.configured),
      canOpenWorkspaces: true,
      canEscalate: model?.canEscalate === true,
    });
    return {
      localAvailable: Boolean(model?.localId),
      localModel: model?.localId ?? null,
      cloudAvailable: Boolean(model?.cloudId),
      cloudModel: model?.cloudId ?? null,
      capabilityCount: count,
      capabilityMode: this.#deps.directCapabilities && count > 0 && count <= room ? 'direct' : 'router',
      // Lo que **queda**, no el cupo. El campo se llama «room» y la pantalla avisa cuando baja de
      // tres: sirviendo el cupo entero, el aviso no saltaba nunca y el repliegue seguía siendo
      // silencioso, que es justo lo que este campo venía a arreglar.
      capabilityRoom: Math.max(0, room - count),
    };
  }

  list(options: { limit?: number; workspaceId?: string } = {}): Conversation[] {
    return this.#repository.list(options);
  }

  find(id: string): Conversation | null { return this.#repository.find(id); }

  require(id: string): Conversation {
    const conversation = this.#repository.find(id);
    if (!conversation) {
      throw new JarvisError('NOT_FOUND', `unknown conversation ${id}`, { scope: { conversationId: id } });
    }
    return conversation;
  }

  messages(id: string, options: { afterSeq?: number } = {}): ChatMessage[] {
    this.require(id);
    return this.#repository.messages(id, options);
  }

  /** Las aprobaciones vivas de una conversación: lo que está esperando a que alguien decida. */
  pendingApprovals(conversationId: string): Approval[] {
    return (this.#deps.db.prepare(
      "SELECT * FROM approvals WHERE conversation_id = ? AND status = 'pending' ORDER BY requested_at",
    ).all(conversationId) as Array<Record<string, unknown>>).map((row) => this.#toApproval(row));
  }

  // ---- creación y ajustes -------------------------------------------------

  create({ title, workspaceId, autonomy, user }: {
    title?: string;
    workspaceId?: string | null;
    autonomy?: AutonomyMode;
    user: UserIdentity;
  }): Conversation {
    if (!this.#deps.model) {
      throw new JarvisError('CONFLICT',
        'no hay modelo configurado para el asistente: fija JARVIS_LOCAL_MODEL_BASE_URL o JARVIS_MODEL_API_KEY en el core');
    }
    // Un workspace que no existe se rechaza aquí y no al primer turno: fallar al crear es
    // entendible, fallar al contestar parece que el asistente está roto.
    if (workspaceId) this.#deps.workspaces.require(workspaceId);

    const conversation = this.#repository.create({
      title: (title ?? 'Conversación nueva').slice(0, 120),
      workspaceId: workspaceId ?? null,
      autonomy: autonomy ?? this.#defaultAutonomy,
      createdBy: user.username,
    });
    this.#deps.audit.record({
      actorUser: user.username,
      eventType: 'chat.created',
      ...(workspaceId ? { workspaceId } : {}),
      payload: { conversationId: conversation.id, autonomy: conversation.autonomy },
    });
    return conversation;
  }

  setAutonomy(id: string, autonomy: AutonomyMode, user: UserIdentity): Conversation {
    const conversation = this.require(id);
    this.#repository.setAutonomy(id, autonomy);
    // Cambiar cuánta cuerda tiene el asistente es una decisión, y queda escrita como tal.
    this.#deps.audit.record({
      actorUser: user.username,
      eventType: 'chat.autonomy_changed',
      ...(conversation.workspaceId ? { workspaceId: conversation.workspaceId } : {}),
      payload: { conversationId: id, from: conversation.autonomy, to: autonomy },
    });
    this.bus.notify(id);
    return this.require(id);
  }

  delete(id: string, user: UserIdentity): void {
    const conversation = this.require(id);
    this.#repository.delete(id);
    this.#deps.audit.record({
      actorUser: user.username, eventType: 'chat.deleted',
      ...(conversation.workspaceId ? { workspaceId: conversation.workspaceId } : {}),
      payload: { conversationId: id },
    });
  }

  // ---- el turno -----------------------------------------------------------

  /**
   * La persona escribe.
   *
   * Devuelve en cuanto el mensaje está guardado; el turno va por detrás y se sigue por el stream.
   * Es la misma forma que tiene crear un run: lo que tarda no se espera dentro de la petición.
   */
  send(id: string, text: string, user: UserIdentity): ChatMessage {
    const conversation = this.require(id);
    const body = text.trim();
    if (!body) throw new JarvisError('BAD_REQUEST', 'el mensaje no puede estar vacío');
    if (!this.#deps.model) {
      throw new JarvisError('CONFLICT', 'no hay modelo configurado para el asistente');
    }

    const message = this.#repository.append(id, { role: 'user', text: body });
    // La primera frase de la persona nombra la conversación: es mejor título que «Conversación
    // nueva» y no cuesta una llamada a ningún modelo.
    if (conversation.messageCount === 0) {
      this.#repository.setTitle(id, body.slice(0, TITLE_CHARS) + (body.length > TITLE_CHARS ? '…' : ''));
    }
    this.bus.notify(id);
    void this.#kick(id, user);
    return message;
  }

  /**
   * Espera a que no quede turno en vuelo sobre esta conversación.
   *
   * Un turno puede encadenar otro —una capacidad aprobada se ejecuta y se le devuelve la palabra
   * al modelo para que cuente qué salió—, así que se espera en bucle hasta que no queda ninguno.
   * El tope es para no quedarse aquí si algo se realimenta sin fin.
   */
  async settled(id: string): Promise<void> {
    for (let guard = 0; guard < 20; guard += 1) {
      const turn = this.#turns.get(id);
      if (!turn) return;
      await turn.catch(() => undefined);
    }
  }

  /** Encola un turno. Si ya hay uno corriendo, éste espera: nunca dos a la vez sobre el mismo hilo. */
  #kick(id: string, user: UserIdentity): Promise<void> {
    const running = this.#turns.get(id);
    const next = (running ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.#turn(id, user));
    this.#turns.set(id, next);
    const release = (): void => {
      if (this.#turns.get(id) === next) this.#turns.delete(id);
    };
    next.then(release, release);
    return next;
  }

  async #turn(id: string, user: UserIdentity): Promise<void> {
    const conversation = this.#repository.find(id);
    const model = this.#deps.model;
    if (!conversation || !model) return;
    // Un hilo esperando una aprobación no piensa: lo que falta es una decisión de la persona.
    if (conversation.status === 'waiting_approval') return;

    const source: ModelSource = conversation.source === 'cloud' && model.canEscalate
      ? 'cloud'
      : model.primarySource;
    this.#repository.setStatus(id, 'thinking');
    this.bus.notify(id);

    const toolbox = await this.#toolboxFor(conversation, user);
    let decision: AssistantDecision;
    try {
      decision = await model.decide(await this.#contextFor(conversation, source), toolbox);
    } catch (error) {
      this.#repository.append(id, {
        role: 'event',
        text: `El asistente no pudo responder: ${(error as Error).message}`,
      });
      this.#repository.setStatus(id, 'failed', 'local');
      this.bus.notify(id);
      return;
    }

    await this.#applyDecision(conversation, decision, user, source, model.id, toolbox);
    this.bus.notify(id);
  }

  /**
   * Lo que el core hace con lo que el modelo decidió.
   *
   * Cada rama termina en un estado que se puede leer en la pantalla y que sobrevive a un
   * reinicio. Ninguna deja el hilo «pensando» para siempre, que es el fallo que convierte un
   * asistente en algo que la gente deja de usar.
   */
  async #applyDecision(
    conversation: Conversation,
    decision: AssistantDecision,
    user: UserIdentity,
    source: ModelSource,
    modelId: string,
    toolbox: AssistantToolbox,
  ): Promise<void> {
    const id = conversation.id;
    /*
     * Lo que el turno dejó pulsable.
     *
     * Va en el mensaje del asistente y no en el de la herramienta que lo produjo: los botones se
     * leen debajo de la respuesta, no dentro de la traza. Y va en **todas** las ramas, aprobaciones
     * incluidas, porque un workspace abierto mientras razonaba sigue estando abierto aunque el
     * turno acabe pidiendo permiso para otra cosa.
     */
    const refs = pickRefs(toolbox.refs);

    if (decision.kind === 'finish') {
      this.#repository.append(id, {
        role: 'assistant', text: decision.summary, source, modelId,
        runIds: decision.evidenceRunIds ?? [], refs,
      });
      // El hilo vuelve a casa después de un turno en la nube: la autorización era para ese turno.
      this.#repository.setStatus(id, 'idle', 'local');
      return;
    }

    if (decision.kind === 'ask') {
      this.#repository.append(id, { role: 'assistant', text: decision.question, source, modelId, refs });
      this.#repository.setStatus(id, 'idle', 'local');
      return;
    }

    if (decision.kind === 'escalate') {
      const approval = this.#createApproval(conversation, {
        actionType: 'escalate',
        target: { model: this.#deps.model?.cloudId ?? 'cloud', reason: decision.reason },
        summary: `Consultar al modelo de la nube. Motivo: ${decision.reason}`,
        user,
      });
      this.#repository.append(id, {
        role: 'assistant',
        text: `Esto se me escapa: ${decision.reason}\n\n¿Consulto al modelo de la nube?`,
        source, modelId, approvalId: approval.id, refs,
      });
      this.#repository.setStatus(id, 'waiting_approval');
      return;
    }

    if (decision.kind === 'capability') {
      const approval = this.#createApproval(conversation, {
        actionType: 'capability',
        // Lo que se aprueba son el nombre y los argumentos exactos: van dentro del digest, así que
        // entre la tarjeta que se lee y lo que se ejecuta no cabe un cambio.
        target: { capability: decision.capability, args: decision.args },
        summary: decision.summary,
        user,
      });
      this.#repository.append(id, {
        role: 'assistant', text: decision.summary, source, modelId, approvalId: approval.id, refs,
      });
      this.#repository.setStatus(id, 'waiting_approval');
      return;
    }

    if (decision.kind === 'approval') {
      if (!conversation.workspaceId) {
        this.#repository.append(id, {
          role: 'event',
          text: 'El asistente pidió lanzar un trabajo, pero esta conversación no está atada a ninguna sesión.',
        });
        this.#repository.setStatus(id, 'idle', 'local');
        return;
      }
      const workspace = this.#deps.workspaces.require(conversation.workspaceId);
      const approval = this.#createApproval(conversation, {
        actionType: 'run',
        target: {
          workspaceId: conversation.workspaceId,
          host: workspace.ref.host,
          provider: workspace.ref.provider,
          permissionProfile: decision.permissionProfile,
          prompt: decision.prompt,
        },
        summary: decision.summary,
        user,
      });
      this.#repository.append(id, {
        role: 'assistant', text: decision.summary, source, modelId, approvalId: approval.id, refs,
      });
      this.#repository.setStatus(id, 'waiting_approval');
      return;
    }

    // Un run directo: sólo llega aquí en autonomía `auto`, porque en `manual` el toolbox ya lo
    // convirtió en una petición de permiso antes de salir del modelo.
    if (!conversation.workspaceId) {
      this.#repository.append(id, {
        role: 'event',
        text: 'El asistente quiso lanzar un trabajo, pero esta conversación no está atada a ninguna sesión.',
      });
      this.#repository.setStatus(id, 'idle', 'local');
      return;
    }
    try {
      const created = await this.#deps.runs.create({
        workspaceId: conversation.workspaceId,
        prompt: decision.prompt,
        permissionProfile: decision.permissionProfile,
        idempotencyKey: `chat:${id}:${this.#repository.messages(id).length}`,
      }, user, `chat:${id}`);
      this.#repository.append(id, {
        role: 'assistant',
        text: `${decision.title}. ${decision.rationale}`.trim(),
        source, modelId, runIds: [created.run.id],
        refs: [...refs, { kind: 'run', runId: created.run.id, title: decision.title }],
      });
    } catch (error) {
      this.#repository.append(id, {
        role: 'event', text: `No se pudo lanzar el trabajo: ${(error as Error).message}`,
      });
    }
    this.#repository.setStatus(id, 'idle', 'local');
  }

  // ---- aprobaciones -------------------------------------------------------

  /**
   * Aprobar o rechazar lo que el asistente pidió.
   *
   * Vive aquí y no en el motor de planes porque **lo que se ejecuta al aprobar es distinto**: un
   * plan sólo sabe lanzar un run; una conversación puede además ejecutar una capacidad del sistema
   * o abrir la puerta a la nube. Comparten la tabla y la forma de la tarjeta; no el efecto.
   */
  async resolveApproval(approvalId: string, decision: 'approved' | 'rejected', user: UserIdentity): Promise<Approval> {
    const { db, clock } = this.#deps;
    const row = db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as Record<string, unknown> | undefined;
    if (!row) throw new JarvisError('NOT_FOUND', `unknown approval ${approvalId}`);
    const approval = this.#toApproval(row);
    if (!approval.conversationId) {
      throw new JarvisError('BAD_REQUEST', 'esa aprobación no es de una conversación');
    }
    if (approval.status !== 'pending') {
      throw new JarvisError(approval.status === 'consumed' ? 'APPROVAL_CONSUMED' : 'CONFLICT',
        `la aprobación ya estaba ${approval.status}`);
    }
    if (Date.parse(approval.expiresAt) <= clock.nowMs()) {
      db.prepare("UPDATE approvals SET status = 'expired' WHERE id = ?").run(approvalId);
      throw new JarvisError('APPROVAL_EXPIRED', 'la aprobación caducó sin respuesta');
    }

    db.prepare('UPDATE approvals SET status = ?, resolved_by = ?, resolved_at = ? WHERE id = ?')
      .run(decision, user.username, clock.nowIso(), approvalId);
    this.#deps.audit.record({
      actorUser: user.username, eventType: 'approval.resolved',
      payload: { approvalId, conversationId: approval.conversationId, actionType: approval.actionType, decision },
    });

    const conversationId = approval.conversationId;
    if (decision === 'rejected') {
      this.#repository.append(conversationId, {
        role: 'event', text: 'No lo autorizaste. El asistente sigue con lo que puede hacer sin eso.',
      });
      this.#repository.setStatus(conversationId, 'idle', 'local');
      this.bus.notify(conversationId);
      return this.#toApproval(db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as Record<string, unknown>);
    }

    // Aprobada: se consume antes del efecto, y si otro ya la consumió no se ejecuta dos veces.
    const consumed = db.prepare(
      "UPDATE approvals SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'approved'",
    ).run(clock.nowIso(), approvalId);
    if (consumed.changes === 0) {
      throw new JarvisError('APPROVAL_CONSUMED', 'esa aprobación ya se había usado');
    }

    await this.#executeApproval(conversationId, approval, user);
    this.bus.notify(conversationId);
    return this.#toApproval(db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as Record<string, unknown>);
  }

  async #executeApproval(conversationId: string, approval: Approval, user: UserIdentity): Promise<void> {
    const target = approval.target as Record<string, unknown>;

    if (approval.actionType === 'escalate') {
      // La puerta se abre para el turno siguiente y se cierra sola al terminarlo (ver `finish`).
      this.#repository.setStatus(conversationId, 'idle', 'cloud');
      this.#repository.append(conversationId, {
        role: 'event', text: 'Autorizado. Consultando al modelo de la nube…',
      });
      this.bus.notify(conversationId);
      void this.#kick(conversationId, user);
      return;
    }

    if (approval.actionType === 'capability') {
      const name = String(target['capability'] ?? '');
      const args = (target['args'] ?? {}) as Record<string, unknown>;
      const conversation = this.#repository.find(conversationId);
      try {
        const result = await this.#deps.mcp?.call(name, args, {
          actor: user.username,
          // Sólo aquí, y sólo porque hay una tarjeta firmada detrás.
          allowWrites: true,
          ...(conversation?.workspaceId ? { workspaceId: conversation.workspaceId } : {}),
        });
        this.#repository.append(conversationId, {
          role: 'tool',
          text: clipText(JSON.stringify(result?.content ?? null), TOOL_ECHO_CHARS),
          toolName: name, toolInput: args, toolOk: result?.ok ?? false,
        });
      } catch (error) {
        this.#repository.append(conversationId, {
          role: 'tool', text: `falló: ${(error as Error).message}`,
          toolName: name, toolInput: args, toolOk: false,
        });
      }
      this.#repository.setStatus(conversationId, 'idle');
      this.bus.notify(conversationId);
      // Se le devuelve el turno para que interprete lo que salió: ejecutar sin contar qué pasó
      // deja a la persona leyendo un volcado.
      void this.#kick(conversationId, user);
      return;
    }

    // Un run autorizado.
    const conversation = this.#repository.find(conversationId);
    if (!conversation?.workspaceId) {
      this.#repository.append(conversationId, {
        role: 'event', text: 'La conversación ya no está atada a una sesión: no se lanzó nada.',
      });
      this.#repository.setStatus(conversationId, 'idle');
      return;
    }
    try {
      const created = await this.#deps.runs.create({
        workspaceId: conversation.workspaceId,
        prompt: String(target['prompt'] ?? ''),
        permissionProfile: (target['permissionProfile'] ?? 'safe') as 'safe' | 'auto' | 'yolo',
        // La clave es de la aprobación: reintentar tras un reinicio observa el run que ya existe
        // en vez de lanzar un segundo.
        idempotencyKey: `approval:${approval.id}`,
      }, user, `chat:${conversationId}`);
      this.#deps.db.prepare('UPDATE approvals SET run_id = ? WHERE id = ?').run(created.run.id, approval.id);
      this.#repository.append(conversationId, {
        role: 'event', text: 'Autorizado. Trabajo lanzado.', runIds: [created.run.id],
      });
    } catch (error) {
      this.#repository.append(conversationId, {
        role: 'event', text: `No se pudo lanzar el trabajo: ${(error as Error).message}`,
      });
    }
    this.#repository.setStatus(conversationId, 'idle');
  }

  #createApproval(conversation: Conversation, { actionType, target, summary, user }: {
    actionType: string;
    target: Record<string, unknown>;
    summary: string;
    user: UserIdentity;
  }): Approval {
    const { db, clock } = this.#deps;
    const id = newApprovalId();
    const at = clock.nowIso();
    // El digest cubre la acción y su destino: cambiar cualquier cosa invalida lo que se concedió.
    const digest = createHash('sha256').update(JSON.stringify({ actionType, target })).digest('hex');
    db.prepare(`INSERT INTO approvals
      (id, plan_id, conversation_id, action_type, target_json, action_digest, summary, requested_by,
       requested_at, expires_at, status)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
      .run(id, conversation.id, actionType, JSON.stringify(target), digest, summary.slice(0, 600),
        user.username, at, new Date(clock.nowMs() + this.#approvalTtlMs).toISOString());
    this.#deps.audit.record({
      actorUser: user.username, eventType: 'approval.requested',
      ...(conversation.workspaceId ? { workspaceId: conversation.workspaceId } : {}),
      payload: { conversationId: conversation.id, approvalId: id, actionType },
    });
    return this.#toApproval(db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Record<string, unknown>);
  }

  // ---- contexto y herramientas -------------------------------------------

  async #contextFor(conversation: Conversation, source: ModelSource): Promise<PlanContext> {
    const history = this.#repository.lastMessages(conversation.id, this.#historyMessages);
    /*
     * El lote de arranque **no** va en el contexto, y esto costó descubrirlo.
     *
     * Lo puse aquí para ahorrar una vuelta en la pregunta más común —«¿cómo va la memoria?»— y
     * funcionaba: iba directo a la herramienta buena. Lo que no vi es lo que le hacía al resto de
     * las conversaciones. Poner cinco herramientas de diagnóstico delante, con un «puedes consultar
     * esto directamente», es decirle qué hacer, no qué existe: ante un «Hola» se ponía a
     * diagnosticar el servidor durante minutos.
     *
     * Medido, y la medida es lo que cierra la discusión: a temperatura 0,8 pasaba dos de cada
     * cuatro veces; bajarla a 0,1 lo volvió determinista **en la dirección mala**, tres de tres.
     * O sea que no era mala suerte del muestreo: con ese contexto delante, diagnosticar era la
     * continuación más probable de un saludo.
     *
     * El catálogo sigue estando: se pide con `list_capabilities`, que es para lo que existe el
     * router. Cuesta una vuelta cuando hace falta, en vez de torcer todas las conversaciones en
     * las que no hacía falta.
     */
    const lastUser = [...history].reverse().find((message) => message.role === 'user');
    const workspace = conversation.workspaceId ? this.#deps.workspaces.require(conversation.workspaceId) : null;
    const found = this.#foundIn(history);
    const house = this.#house();

    return {
      objective: lastUser?.text ?? '',
      ...(found.length ? { found } : {}),
      ...(house ? { house } : {}),
      ...(workspace ? {
        workspace: {
          id: workspace.id,
          host: workspace.ref.host,
          provider: workspace.ref.provider,
          sessionId: workspace.ref.sessionId,
          cwd: workspace.cwd,
          title: workspace.title,
        },
      } : {}),
      history: [],
      // El hilo, tal cual, menos el último mensaje de la persona, que ya va como objetivo.
      messages: history
        .filter((message) => message !== lastUser)
        .map((message) => ({
          role: message.role === 'user' ? 'user' as const
            : message.role === 'tool' ? 'tool' as const
              : 'assistant' as const,
          text: message.toolName ? `${message.toolName} → ${clipText(message.text, 400)}` : clipText(message.text, 600),
        })),
      pendingInput: null,
      pendingApprovals: this.pendingApprovals(conversation.id)
        .map((approval) => ({ id: approval.id, summary: approval.summary, expiresAt: approval.expiresAt })),
      source,
      limits: {
        stepsUsed: 0,
        maxSteps: 1,
        maxToolCalls: this.#maxToolCalls,
        maxToolOutputBytes: 60_000,
      },
    };
  }

  /**
   * El toolbox del turno, envuelto para que cada consulta quede escrita en el hilo.
   *
   * Envolver en vez de tocar el toolbox de siempre mantiene una sola implementación de las
   * herramientas para el plan y para la conversación: lo que cambia no es lo que hacen, sino que
   * aquí además se ven.
   */
  async #toolboxFor(conversation: Conversation, user: UserIdentity): Promise<AssistantToolbox> {
    const workspace = conversation.workspaceId ? this.#deps.workspaces.require(conversation.workspaceId) : null;
    /*
     * El catálogo entero como herramientas propias, si el modelo puede con él.
     *
     * Se resuelve aquí porque pedirlo es asíncrono y el toolbox se construye en frío. Si el
     * servidor MCP no contesta se sigue sin capacidades: el asistente hará menos, pero hará.
     */
    const capabilityTools = this.#deps.mcp?.configured && this.#deps.directCapabilities
      ? await this.#deps.mcp.asToolDefinitions().catch(() => [])
      : [];

    const inner = new CoreAssistantToolbox({
      ...(capabilityTools.length ? { capabilityTools } : {}),
      ...(this.#deps.maxTools ? { maxTools: this.#deps.maxTools } : {}),
      ...(workspace ? { workspace } : {}),
      actorRef: `chat:${conversation.id}`,
      sessions: this.#deps.sessions,
      // Sólo la conversación: un plan ya trabaja sobre una sesión, y dejarle abrir otras le
      // ensancha el alcance sin que nadie lo haya pedido.
      workspaces: this.#deps.workspaces,
      // Y lo que ya se encontró, porque el toolbox es de un turno y la conversación no.
      knownSessions: this.#knownSessions(this.#repository.lastMessages(conversation.id, this.#historyMessages)),
      health: this.#deps.health,
      runs: this.#deps.runs,
      audit: this.#deps.audit,
      user,
      ...(this.#deps.attachments ? { attachments: this.#deps.attachments } : {}),
      ...(this.#deps.evidence ? { evidence: this.#deps.evidence } : {}),
      ...(this.#deps.mcp ? { mcp: this.#deps.mcp } : {}),
      ...(this.#deps.starterCapabilities ? { starterCapabilities: this.#deps.starterCapabilities } : {}),
      ...(this.#deps.toolLimits ? { limits: this.#deps.toolLimits } : {}),
      // La conversación sí sabe ejecutar una capacidad con efectos tras aprobarla.
      capabilityWrites: true,
      autonomy: conversation.autonomy,
      canEscalate: this.#deps.model?.canEscalate === true,
      maxObservations: this.#maxToolCalls,
      // Lo que de verdad acota la espera de quien está mirando la pantalla.
      maxTurnMs: this.#maxTurnMs,
      now: () => this.#deps.clock.nowMs(),
    });
    return new RecordingToolbox(inner, this.#repository, this.bus, conversation.id);
  }

  /**
   * Lo que este hilo ya encontró, sacado de las referencias guardadas.
   *
   * De las referencias y no del eco de las herramientas: el eco se guarda recortado a 1200
   * caracteres y parsearlo es adivinar. Una referencia es un dato tipado que ya pasó por el
   * contrato.
   *
   * Una sesión con workspace abierto se cuenta una sola vez y lo dice: es la diferencia entre
   * «ábremela» y «ya está abierta, aquí la tienes».
   */
  #foundIn(history: readonly ChatMessage[]): NonNullable<PlanContext['found']> {
    const byId = new Map<string, NonNullable<PlanContext['found']>[number]>();
    const workspaceOf = new Map<string, string>();
    const openedIds: string[] = [];
    for (const message of history) {
      for (const ref of message.refs) {
        if (ref.kind === 'session' || ref.kind === 'terminal') {
          /*
           * Lo que se sabía no se pierde al volver a nombrar la sesión.
           *
           * Una referencia `terminal` no lleva título, y el orden natural es encontrar la sesión
           * y **después** ofrecer la terminal en ella: sobrescribir sin más dejaba el contexto
           * diciendo «hay una sesión en zeus» sin decir de qué iba, que es justo lo que se vino a
           * arreglar. Se borra antes de insertar para que la más nombrada quede la última: un
           * `Map` conserva el orden de la primera inserción, y `set` sobre una clave que ya está
           * no la mueve.
           */
          const previous = byId.get(ref.sessionId);
          byId.delete(ref.sessionId);
          byId.set(ref.sessionId, {
            host: ref.host,
            provider: ref.provider,
            sessionId: ref.sessionId,
            title: (ref.kind === 'session' ? ref.title : null) ?? previous?.title ?? null,
            workspaceId: null,
          });
        }
        if (ref.kind === 'terminal' && ref.workspaceId) workspaceOf.set(ref.sessionId, ref.workspaceId);
        // El workspace se apunta aparte: la referencia no lleva la sesión, la lleva la base. Se
        // recogen los ids y se resuelven de una vez, en lugar de consultar dentro del bucle.
        if (ref.kind === 'workspace') openedIds.push(ref.workspaceId);
      }
    }
    for (const workspaceId of new Set(openedIds)) {
      const opened = this.#deps.workspaces.find(workspaceId);
      if (opened) workspaceOf.set(opened.ref.sessionId, opened.id);
    }
    return [...byId.values()]
      .map((session) => ({ ...session, workspaceId: workspaceOf.get(session.sessionId) ?? null }))
      .slice(-6);
  }

  /**
   * Lo que el hilo ya sabe de cada sesión, para el toolbox del turno que viene.
   *
   * Es lo mismo que `#foundIn` le cuenta al modelo, pero con el `cwd` y en la forma que consumen
   * las herramientas. Existe porque el toolbox se construye uno por turno: sin esto, pedir en el
   * tercer turno una terminal sobre la sesión que se encontró en el primero la abría en el home,
   * y el modelo no reenvía el directorio que se le dio.
   */
  #knownSessions(history: readonly ChatMessage[]): SeenSession[] {
    const byId = new Map<string, SeenSession>();
    const opened: string[] = [];
    for (const message of history) {
      for (const ref of message.refs) {
        if (ref.kind === 'workspace') opened.push(ref.workspaceId);
        if (ref.kind !== 'session' && ref.kind !== 'terminal') continue;
        const previous = byId.get(ref.sessionId);
        byId.set(ref.sessionId, {
          ref: { host: ref.host, provider: ref.provider, sessionId: ref.sessionId },
          title: (ref.kind === 'session' ? ref.title : null) ?? previous?.title ?? null,
          cwd: ref.cwd ?? previous?.cwd ?? null,
          workspaceId: (ref.kind === 'terminal' ? ref.workspaceId : null) ?? previous?.workspaceId ?? null,
        });
      }
    }
    /*
     * Un workspace abierto en un turno anterior le da a su sesión el `cwd` y el enlace de vuelta.
     *
     * La referencia `workspace` no dice de qué sesión es —eso lo sabe la base— así que se resuelve
     * aquí, una vez por id y no dentro del bucle.
     */
    for (const workspaceId of new Set(opened)) {
      const workspace = this.#deps.workspaces.find(workspaceId);
      if (!workspace) continue;
      const previous = byId.get(workspace.ref.sessionId);
      byId.set(workspace.ref.sessionId, {
        ref: workspace.ref,
        title: previous?.title ?? workspace.title,
        cwd: previous?.cwd ?? workspace.cwd,
        workspaceId: workspace.id,
      });
    }
    return [...byId.values()];
  }

  /**
   * Qué hay abierto y qué corre ahora mismo.
   *
   * Dos consultas a SQLite y ninguna a la red, que es lo que permite ponerlo en el contexto de
   * cada turno: la alternativa era que el modelo gastara una vuelta —diez segundos y una factura—
   * preguntando lo que la base contesta en un milisegundo.
   *
   * Devuelve `null` si no hay nada. Un bloque que dice «no hay nada» ocupa lo mismo que uno que
   * dice algo y no informa de nada.
   */
  #house(): PlanContext['house'] | null {
    const workspaces = this.#deps.workspaces.recent(4).map((workspace) => ({
      id: workspace.id,
      title: workspace.title,
      host: workspace.ref.host,
      provider: workspace.ref.provider,
    }));
    // Sólo lo vivo: un trabajo terminado hace tres días no es estado de la casa, es histórico, y
    // para eso está `list_runs`.
    const runs = this.#deps.runs.listRecent(12)
      .filter((run) => !isTerminalStatus(run.status))
      .slice(0, 4)
      // Un trabajo no tiene título: lo que tiene es lo que se le pidió. Recortado, porque un prompt
      // entero por cada trabajo vivo convierte cien palabras de contexto en mil.
      .map((run) => ({ runId: run.id, status: run.status, title: clipText(run.promptPreview ?? '', 80) || null }));
    return workspaces.length || runs.length ? { workspaces, runs } : null;
  }

  #toApproval(row: Record<string, unknown>): Approval {
    return {
      id: String(row['id']),
      planId: (row['plan_id'] as string | null) ?? null,
      conversationId: (row['conversation_id'] as string | null) ?? null,
      runId: (row['run_id'] as string | null) ?? null,
      actionType: String(row['action_type']),
      target: JSON.parse(String(row['target_json'])) as unknown,
      actionDigest: String(row['action_digest']),
      summary: String(row['summary']),
      requestedBy: String(row['requested_by']),
      requestedAt: String(row['requested_at']),
      expiresAt: String(row['expires_at']),
      status: row['status'] as Approval['status'],
      resolvedBy: (row['resolved_by'] as string | null) ?? null,
      resolvedAt: (row['resolved_at'] as string | null) ?? null,
      consumedAt: (row['consumed_at'] as string | null) ?? null,
    };
  }
}

/**
 * El toolbox que deja rastro.
 *
 * Cada lectura se escribe en el hilo en cuanto ocurre, y por eso la pantalla puede decir «mirando
 * la memoria…» mientras el modelo sigue pensando. Las decisiones no se escriben aquí: las escribe
 * el servicio, que es quien sabe en qué acaban.
 */
class RecordingToolbox implements AssistantToolbox {
  readonly #inner: AssistantToolbox;
  readonly #repository: ChatRepository;
  readonly #bus: ChatEventBus;
  readonly #conversationId: string;

  constructor(inner: AssistantToolbox, repository: ChatRepository, bus: ChatEventBus, conversationId: string) {
    this.#inner = inner;
    this.#repository = repository;
    this.#bus = bus;
    this.#conversationId = conversationId;
  }

  get terminalOffer(): AssistantToolbox['terminalOffer'] { return this.#inner.terminalOffer; }
  get refs(): AssistantToolbox['refs'] { return this.#inner.refs; }
  get repeats(): number { return this.#inner.repeats; }
  get observations(): number { return this.#inner.observations; }
  get spent(): boolean { return this.#inner.spent; }

  definitions(options?: { decisionsOnly?: boolean }): ToolDefinition[] {
    return this.#inner.definitions(options);
  }

  async invoke(name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
    const outcome = await this.#inner.invoke(name, input);
    if (outcome.type === 'observation') {
      const content = outcome.content as { ok?: unknown; name?: unknown; error?: { code?: unknown } } | null;
      /*
       * Una repetición cortada no se escribe en el hilo.
       *
       * Porque no se consultó nada: el memo la paró antes de salir. Una fila `tool` dice «miré
       * esto», y ponerla aquí sería afirmar una consulta que no ocurrió — y además dejaría la
       * repetición contada en la base, que es justo la cifra que este trabajo venía a bajar.
       *
       * Que no deje rastro no es que no se sepa: el turno la cuenta en `toolbox.repeats`, que es
       * donde se mira si el modelo sigue dando vueltas.
       */
      if (content?.error?.code === 'ALREADY_ASKED') return outcome;
      /*
       * Lo que se guarda es **qué se consultó**, no con qué herramienta ni con qué nombre interno.
       *
       * Si la observación dice qué se consultó de verdad, gana. Sirve para los dos modos y por el
       * mismo motivo: en el router el nombre de la herramienta es `use_capability`, que es el
       * mecanismo y no el hecho; en el directo es `mcp__zeus__memory_pressure`, que lleva dentro
       * un aplanado que existe sólo porque la API no admite puntos. Lo que una persona quiere leer
       * en el hilo es `zeus.memory_pressure` en los dos casos.
       */
      const shown = typeof content?.name === 'string' ? content.name : name;
      this.#repository.append(this.#conversationId, {
        role: 'tool',
        text: clipText(JSON.stringify(outcome.content), TOOL_ECHO_CHARS),
        toolName: shown,
        toolInput: input,
        toolOk: content?.ok !== false,
      });
      this.#bus.notify(this.#conversationId);
    }
    return outcome;
  }
}

/**
 * Las referencias que acaban en un mensaje.
 *
 * Sin duplicados y con tope: un mensaje con doce botones debajo no es una acción, es ruido. Se
 * quedan las últimas, que son las del final del razonamiento y las que la respuesta comenta.
 */
const MAX_MESSAGE_REFS = 4;

/** La identidad de una referencia, que no es el objeto entero: el mismo workspace con dos títulos
 *  distintos —antes y después de renombrarlo— son dos botones al mismo sitio. */
const refKey = (ref: ChatRef): string => (ref.kind === 'workspace' ? `workspace:${ref.workspaceId}`
  : ref.kind === 'run' ? `run:${ref.runId}`
    : `${ref.kind}:${ref.host}|${ref.provider}|${ref.sessionId}`);

function pickRefs(refs: readonly ChatRef[]): ChatRef[] {
  const seen = new Set<string>();
  const unique: ChatRef[] = [];
  /*
   * La oferta de terminal tiene sitio reservado.
   *
   * Las cuatro clases no pesan igual en pantalla: un workspace, una sesión o un trabajo son una
   * pastilla en una fila; la terminal es un bloque con el motivo escrito, y es la única que
   * explica **por qué** conviene mirar. Sin reserva, un turno que ofrece pronto y luego mira
   * cuatro sesiones más la empuja fuera del tope, y como el motivo vive dentro de la propia
   * referencia no queda ni rastro de que llegó a ofrecerla.
   */
  const ordered = [...refs].reverse();
  const terminal = ordered.find((ref) => ref.kind === 'terminal');
  for (const ref of terminal ? [terminal, ...ordered] : ordered) {
    const key = refKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ref);
    if (unique.length >= MAX_MESSAGE_REFS) break;
  }
  return unique.reverse();
}

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

