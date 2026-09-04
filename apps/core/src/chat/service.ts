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
  Approval, AutonomyMode, ChatCapabilities, ChatMessage, Conversation, ModelSource, UserIdentity,
} from '@jarvis/contracts';
import { JarvisError } from '@jarvis/contracts';
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
import { CoreAssistantToolbox, type ToolboxLimits } from '../assistant/toolbox.js';
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
  approvalTtlMs?: number;
  starterCapabilities?: readonly string[];
  toolLimits?: Partial<ToolboxLimits>;
}

export class ChatService {
  readonly #deps: ChatServiceDeps;
  readonly #repository: ChatRepository;
  readonly #maxToolCalls: number;
  readonly #historyMessages: number;
  readonly #defaultAutonomy: AutonomyMode;
  readonly #approvalTtlMs: number;
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
  }

  // ---- consulta -----------------------------------------------------------

  /** Lo que la interfaz necesita para no ofrecer lo que no existe. */
  async capabilities(): Promise<ChatCapabilities> {
    const model = this.#deps.model;
    return {
      localAvailable: Boolean(model?.localId),
      localModel: model?.localId ?? null,
      cloudAvailable: Boolean(model?.cloudId),
      cloudModel: model?.cloudId ?? null,
      capabilityCount: this.#deps.mcp?.configured ? await this.#deps.mcp.count().catch(() => 0) : 0,
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

    const toolbox = this.#toolboxFor(conversation, user);
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

    await this.#applyDecision(conversation, decision, user, source, model.id);
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
  ): Promise<void> {
    const id = conversation.id;

    if (decision.kind === 'finish') {
      this.#repository.append(id, {
        role: 'assistant', text: decision.summary, source, modelId,
        runIds: decision.evidenceRunIds ?? [],
      });
      // El hilo vuelve a casa después de un turno en la nube: la autorización era para ese turno.
      this.#repository.setStatus(id, 'idle', 'local');
      return;
    }

    if (decision.kind === 'ask') {
      this.#repository.append(id, { role: 'assistant', text: decision.question, source, modelId });
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
        source, modelId, approvalId: approval.id,
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
        role: 'assistant', text: decision.summary, source, modelId, approvalId: approval.id,
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
        role: 'assistant', text: decision.summary, source, modelId, approvalId: approval.id,
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
     * El lote de arranque va dentro del contexto, no detrás de una consulta.
     *
     * Cada ida y vuelta con el modelo de casa cuesta de diez a veinte segundos, así que gastar la
     * primera en preguntar «¿qué herramientas hay?» es gastar un cuarto de la respuesta en algo que
     * cabe en veinte líneas. Si el catálogo no se puede pedir, se sigue sin él: el asistente
     * contestará peor, pero contestará.
     */
    const starter = this.#deps.mcp?.configured
      ? await this.#deps.mcp.describe(this.#deps.starterCapabilities ?? []).catch(() => [])
      : [];
    const lastUser = [...history].reverse().find((message) => message.role === 'user');
    const workspace = conversation.workspaceId ? this.#deps.workspaces.require(conversation.workspaceId) : null;

    return {
      objective: lastUser?.text ?? '',
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
      ...(starter.length ? {
        capabilities: starter.map((capability) => ({
          name: capability.name,
          summary: capability.summary,
          params: compactParams(capability.inputSchema),
        })),
      } : {}),
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
  #toolboxFor(conversation: Conversation, user: UserIdentity): AssistantToolbox {
    const workspace = conversation.workspaceId ? this.#deps.workspaces.require(conversation.workspaceId) : null;
    const inner = new CoreAssistantToolbox({
      ...(workspace ? { workspace } : {}),
      actorRef: `chat:${conversation.id}`,
      sessions: this.#deps.sessions,
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
    });
    return new RecordingToolbox(inner, this.#repository, this.bus, conversation.id);
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
  get observations(): number { return this.#inner.observations; }

  definitions(options?: { decisionsOnly?: boolean }): ToolDefinition[] {
    return this.#inner.definitions(options);
  }

  async invoke(name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
    const outcome = await this.#inner.invoke(name, input);
    if (outcome.type === 'observation') {
      const content = outcome.content as { ok?: unknown; name?: unknown } | null;
      /*
       * Lo que se guarda es **qué se consultó**, no con qué herramienta.
       *
       * `use_capability` es el mecanismo; lo que a una persona le sirve leer en el hilo es
       * `zeus.memory_pressure`. Se prefiere el nombre que devuelve la propia observación porque
       * viene ya cualificado con el servidor, que es lo que hace falta cuando hay más de uno.
       */
      const shown = name === 'use_capability' && typeof content?.name === 'string'
        ? content.name
        : name;
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

function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Los parámetros de una capacidad en una línea. El esquema entero cuesta más de lo que aporta. */
function compactParams(schema: unknown): string {
  const object = schema as { properties?: Record<string, { type?: string }>; required?: string[] } | null;
  const properties = object?.properties;
  if (!properties || !Object.keys(properties).length) return 'sin parámetros';
  const required = new Set(object?.required ?? []);
  return Object.entries(properties)
    .map(([name, spec]) => `${name}: ${spec?.type ?? 'any'}${required.has(name) ? ' (obligatorio)' : ''}`)
    .join(', ');
}
