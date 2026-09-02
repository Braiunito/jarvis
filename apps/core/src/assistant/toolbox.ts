/**
 * Las herramientas del Assistant, sobre los casos de uso del core.
 *
 * Esto es lo que convierte al coordinador en algo más que un generador de texto: puede mirar el
 * índice de sesiones, leer el transcript, preguntar por la salud de la flota y consultar los
 * trabajos que él mismo lanzó. Todas esas operaciones son **cortas**: se resuelven dentro del
 * turno y devuelven un snapshot acotado.
 *
 * Tres reglas gobiernan este fichero:
 *
 *  1. Una herramienta llama al mismo caso de uso que llama REST. Nunca a la API HTTP, nunca a una
 *     copia de la lógica. Un camino, una semántica, una auditoría (ADR-004).
 *  2. Lo que devuelve va acotado y **dice** que va acotado. Un modelo al que se le recorta la
 *     evidencia en silencio concluye sobre lo que no vio.
 *  3. Lo que espera —un run de cuarenta minutos, una aprobación— no se espera aquí: se devuelve
 *     como decisión, el core la persiste y el turno termina. Ninguna llamada abierta.
 */
import type {
  Health, PermissionProfile, Plan, Provider, Run, RunEvent, UserIdentity, Workspace,
} from '@jarvis/contracts';
import { JarvisError } from '@jarvis/contracts';
import type { SessionService } from '../sessions/service.js';
import type { HealthService } from '../health/service.js';
import type { RunService } from '../runs/service.js';
import type { AuditLog } from '../platform/audit.js';
import type {
  AssistantToolbox, TerminalOffer, ToolDefinition, ToolOutcome,
} from './types.js';

const PROVIDERS: readonly Provider[] = ['claude', 'codex', 'opencode'];
const PROFILES: readonly PermissionProfile[] = ['safe', 'auto', 'yolo'];

export interface ToolboxLimits {
  /** Cuántas sesiones puede devolver una búsqueda. Una lista que no se puede leer no es una lista. */
  maxSessions: number;
  maxTranscriptMessages: number;
  maxRuns: number;
  maxRunEvents: number;
  /** Tope por trozo de texto citado (preview, mensaje, resumen). */
  maxTextChars: number;
}

export const DEFAULT_TOOLBOX_LIMITS: ToolboxLimits = {
  maxSessions: 8,
  maxTranscriptMessages: 12,
  maxRuns: 10,
  maxRunEvents: 12,
  maxTextChars: 1200,
};

export interface CoreToolboxDeps {
  plan: Plan;
  workspace: Workspace;
  sessions: SessionService;
  health: HealthService;
  runs: RunService;
  audit: AuditLog;
  user: UserIdentity;
  limits?: Partial<ToolboxLimits>;
  /**
   * Cuántas lecturas admite el turno. El tope lo pone el core, no la lista de herramientas que se
   * le ofrece al modelo: un modelo puede llamar a lo que no se le ofreció, y entonces el único
   * freno de verdad es este.
   */
  maxObservations?: number;
}

/** Recorta diciendo que recorta, con el tamaño que había antes. Nunca en silencio (ADR-007). */
function clip(text: string | null | undefined, max: number): { text: string; truncated: boolean; originalChars?: number } {
  const value = text ?? '';
  if (value.length <= max) return { text: value, truncated: false };
  return { text: `${value.slice(0, max)}…`, truncated: true, originalChars: value.length };
}

/** Un fallo de herramienta se le cuenta al modelo para que se corrija, no se le lanza encima. */
function toolError(code: string, message: string, hint?: string): ToolOutcome {
  return { type: 'observation', content: { ok: false, error: { code, message, ...(hint ? { hint } : {}) } } };
}

const asString = (value: unknown): string | null =>
  (typeof value === 'string' && value.trim() ? value.trim() : null);

const asInt = (value: unknown, fallback: number, max: number): number => {
  const parsed = typeof value === 'number' ? Math.floor(value) : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
};

const asProfile = (value: unknown, fallback: PermissionProfile): PermissionProfile =>
  (PROFILES as readonly string[]).includes(String(value)) ? value as PermissionProfile : fallback;

/**
 * El catálogo.
 *
 * Las descripciones son parte del producto: un modelo elige mal cuando le describen mal. Dicen
 * qué hace la herramienta, cuándo conviene y qué **no** hace, que suele ser lo que evita el
 * intento equivocado.
 */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([
  {
    name: 'search_sessions',
    description: 'Busca sesiones de agente indexadas en la flota (Claude Code, Codex, OpenCode). '
      + 'Sirve para localizar trabajo anterior relacionado con el objetivo antes de repetirlo. '
      + 'Es solo lectura y puede devolver datos viejos: la respuesta dice cuándo se miró.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Texto a buscar en título, ruta o primeras líneas.' },
        host: { type: 'string', description: 'Limitar a una máquina.' },
        provider: { type: 'string', enum: [...PROVIDERS] },
        limit: { type: 'integer', description: 'Cuántas sesiones traer. Se acota por arriba.' },
      },
    },
    decides: false,
  },
  {
    name: 'get_session_context',
    description: 'Últimos mensajes de la sesión de este workspace, tal como los guardó el CLI '
      + 'remoto. Úsalo para saber qué se estaba haciendo antes de proponer nada. Devuelve un '
      + 'extracto acotado, no la conversación entera.',
    inputSchema: {
      type: 'object',
      properties: { last: { type: 'integer', description: 'Cuántos mensajes finales leer.' } },
    },
    decides: false,
  },
  {
    name: 'get_health',
    description: 'Salud por salto: base de datos, índice de sesiones, cada host por SSH y el '
      + 'supervisor de trabajos. Consúltalo cuando algo falle o antes de prometer trabajo en una '
      + 'máquina concreta. Que un host esté caído no invalida a los demás.',
    inputSchema: {
      type: 'object',
      properties: {
        probeHosts: { type: 'boolean', description: 'Sondear los hosts ahora en vez de usar lo último conocido. Es lento.' },
      },
    },
    decides: false,
  },
  {
    name: 'list_runs',
    description: 'Trabajos de este workspace y su estado, del más reciente al más antiguo. '
      + 'Incluye los que lanzó esta persona a mano, no solo los tuyos.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
    decides: false,
  },
  {
    name: 'get_run',
    description: 'Detalle de un trabajo: destino efectivo, permiso, estado y, si lo pides, las '
      + 'últimas líneas que escribió el agente. Es la forma de mirar la evidencia sin copiarla '
      + 'entera a la síntesis.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        includeOutput: { type: 'boolean', description: 'Adjuntar el final de la salida del agente.' },
      },
      required: ['runId'],
    },
    decides: false,
  },
  {
    name: 'cancel_run',
    description: 'Para un trabajo de este workspace que sigue en marcha. Úsalo cuando quedó '
      + 'claro que va por mal camino; el motivo queda en la auditoría.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' }, reason: { type: 'string' } },
      required: ['runId'],
    },
    decides: false,
  },
  {
    name: 'open_terminal_offer',
    description: 'Deja preparada una oferta de terminal viva sobre esta sesión, que la persona '
      + 'abre si quiere. No abre nada por su cuenta. Ofrécelo cuando haga falta supervisar, algo '
      + 'vaya a preguntar a mitad, o el fallo se vea distinto cada vez.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Por qué conviene mirarlo en vivo.' },
        permissionProfile: { type: 'string', enum: [...PROFILES] },
      },
      required: ['reason'],
    },
    decides: false,
  },
  {
    name: 'create_run',
    description: 'Encarga un trabajo al agente de esta sesión y cierra tu turno. El servidor lo '
      + 'ejecuta, sobrevive a reinicios y te despierta con el resultado: no esperes aquí. '
      + 'Empieza siempre en solo lectura salvo que ya tengas una aprobación para escribir.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Nombre corto del paso, para la lista del plan.' },
        prompt: { type: 'string', description: 'Lo que el agente debe hacer, con el contexto que necesite.' },
        permission_profile: { type: 'string', enum: ['safe', 'auto'] },
        rationale: { type: 'string', description: 'Por qué este paso ahora.' },
      },
      required: ['title', 'prompt', 'permission_profile'],
    },
    decides: true,
  },
  {
    name: 'request_approval',
    description: 'Pide permiso antes de una acción con efectos. La tarjeta enseña acción, '
      + 'destino y permiso, caduca y sirve una sola vez. Cierra tu turno.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        summary: { type: 'string', description: 'Qué se va a hacer y dónde, en una frase que se pueda leer antes de aprobar.' },
        prompt: { type: 'string', description: 'La orden exacta que se ejecutará si se aprueba.' },
        permission_profile: { type: 'string', enum: ['auto', 'yolo'] },
      },
      required: ['title', 'summary', 'prompt', 'permission_profile'],
    },
    decides: true,
  },
  {
    name: 'ask_human',
    description: 'Pregunta algo que solo la persona puede decidir. Cierra tu turno: el plan '
      + 'duerme hasta que conteste. No lo uses para pedir permiso —eso es request_approval— ni '
      + 'para lo que puedas averiguar con las otras herramientas.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, question: { type: 'string' } },
      required: ['title', 'question'],
    },
    decides: true,
  },
  {
    name: 'finish',
    description: 'Cierra el plan con una síntesis. Cita los trabajos por su id en evidence_run_ids '
      + 'en vez de copiar su salida: la interfaz enlaza a la evidencia completa.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Qué se hizo, qué se encontró y qué queda.' },
        evidence_run_ids: { type: 'array', items: { type: 'string' }, description: 'Trabajos que sostienen la síntesis.' },
      },
      required: ['summary'],
    },
    decides: true,
  },
]);

/**
 * El adaptador de verdad, atado a un plan concreto.
 *
 * Se construye por turno: sabe de qué workspace habla y con qué identidad actúa, así que ninguna
 * herramienta puede alcanzar el trabajo de otro workspace ni actuar como otra persona.
 */
export class CoreAssistantToolbox implements AssistantToolbox {
  readonly #deps: CoreToolboxDeps;
  readonly #limits: ToolboxLimits;
  readonly #maxObservations: number;
  #terminalOffer: TerminalOffer | null = null;
  #observations = 0;

  constructor(deps: CoreToolboxDeps) {
    this.#deps = deps;
    this.#limits = { ...DEFAULT_TOOLBOX_LIMITS, ...deps.limits };
    this.#maxObservations = deps.maxObservations ?? 6;
  }

  get terminalOffer(): TerminalOffer | null { return this.#terminalOffer; }
  get observations(): number { return this.#observations; }

  definitions({ decisionsOnly = false }: { decisionsOnly?: boolean } = {}): ToolDefinition[] {
    return TOOL_DEFINITIONS.filter((tool) => !decisionsOnly || tool.decides);
  }

  async invoke(name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
    const definition = TOOL_DEFINITIONS.find((tool) => tool.name === name);
    if (!definition) {
      return toolError('UNKNOWN_TOOL', `no existe la herramienta ${name}`,
        `las que hay son: ${TOOL_DEFINITIONS.map((tool) => tool.name).join(', ')}`);
    }
    if (!definition.decides) {
      if (this.#observations >= this.#maxObservations) {
        return toolError('BUDGET_SPENT', 'se agotaron las consultas de este turno',
          'decide ya con create_run, request_approval, ask_human o finish; el plan sigue vivo y '
          + 'podrás volver a consultar en el siguiente turno');
      }
      this.#observations += 1;
    }
    try {
      return await this.#run(name, input);
    } catch (error) {
      // Un salto roto no tumba el turno: se cuenta como lo que es y el modelo decide con eso.
      if (error instanceof JarvisError) {
        return toolError(error.code, error.message,
          error.retryable ? 'puede funcionar si se reintenta' : undefined);
      }
      return toolError('TOOL_FAILED', (error as Error).message);
    }
  }

  async #run(name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
    switch (name) {
      case 'search_sessions': return this.#searchSessions(input);
      case 'get_session_context': return this.#sessionContext(input);
      case 'get_health': return this.#health(input);
      case 'list_runs': return this.#listRuns(input);
      case 'get_run': return this.#getRun(input);
      case 'cancel_run': return this.#cancelRun(input);
      case 'open_terminal_offer': return this.#offerTerminal(input);
      case 'create_run': return this.#createRun(input);
      case 'request_approval': return this.#requestApproval(input);
      case 'ask_human': return this.#askHuman(input);
      case 'finish': return this.#finish(input);
      default: return toolError('UNKNOWN_TOOL', `no existe la herramienta ${name}`);
    }
  }

  // ---- lecturas -----------------------------------------------------------

  async #searchSessions(input: Record<string, unknown>): Promise<ToolOutcome> {
    const provider = asString(input['provider']);
    if (provider && !(PROVIDERS as readonly string[]).includes(provider)) {
      return toolError('BAD_INPUT', `provider desconocido: ${provider}`,
        `los válidos son ${PROVIDERS.join(', ')}`);
    }
    const limit = asInt(input['limit'], this.#limits.maxSessions, this.#limits.maxSessions);
    const result = await this.#deps.sessions.search({
      ...(asString(input['q']) ? { q: asString(input['q']) as string } : {}),
      ...(asString(input['host']) ? { host: asString(input['host']) as string } : {}),
      ...(provider ? { provider: provider as Provider } : {}),
      limit,
    });
    const sessions = result.sessions.slice(0, limit).map((session) => ({
      host: session.ref.host,
      provider: session.ref.provider,
      sessionId: session.ref.sessionId,
      title: session.title,
      cwd: session.cwd,
      lastActivityAt: session.lastActivityAt,
      messageCount: session.messageCount,
      preview: clip(session.preview, 240).text,
      workspaceId: session.workspaceId,
    }));
    return {
      type: 'observation',
      content: {
        ok: true,
        sessions,
        returned: sessions.length,
        omitted: Math.max(0, result.sessions.length - sessions.length),
        // Un índice viejo sigue sirviendo si se dice que es viejo.
        stale: result.stale,
        fetchedAt: result.fetchedAt,
        freshness: result.freshness.map((entry) => ({
          host: entry.host, status: entry.status, ageSeconds: entry.ageSeconds,
        })),
      },
    };
  }

  async #sessionContext(input: Record<string, unknown>): Promise<ToolOutcome> {
    const last = asInt(input['last'], this.#limits.maxTranscriptMessages, this.#limits.maxTranscriptMessages);
    const { workspace } = this.#deps;
    const transcript = await this.#deps.sessions.transcript(workspace.ref, { last });
    let clipped = false;
    const messages = transcript.messages.slice(-last).map((message) => {
      const text = clip(message.text, this.#limits.maxTextChars);
      if (text.truncated) clipped = true;
      return { role: message.role, at: message.at, text: text.text, provenance: message.provenance };
    });
    return {
      type: 'observation',
      content: {
        ok: true,
        session: { host: workspace.ref.host, provider: workspace.ref.provider, sessionId: workspace.ref.sessionId },
        cwd: workspace.cwd,
        messages,
        // Dos truncados distintos: el del índice y el nuestro. Se dicen los dos.
        truncatedByIndex: transcript.truncated,
        messagesClipped: clipped,
      },
    };
  }

  async #health(input: Record<string, unknown>): Promise<ToolOutcome> {
    const probeHosts = input['probeHosts'] === true;
    const health: Health = await this.#deps.health.snapshot({ probeHosts });
    const checks: Record<string, unknown> = {};
    for (const [name, check] of Object.entries(health.checks)) {
      // El `detail` de un check trae listas enteras de hosts y contadores: no es contexto, es peso.
      checks[name] = {
        status: check.status,
        ...(check.code ? { code: check.code } : {}),
        ...(check.message ? { message: clip(check.message, 200).text } : {}),
        ...(check.lastOkAt ? { lastOkAt: check.lastOkAt } : {}),
      };
    }
    return { type: 'observation', content: { ok: true, status: health.status, at: health.at, checks, probed: probeHosts } };
  }

  #listRuns(input: Record<string, unknown>): ToolOutcome {
    const limit = asInt(input['limit'], this.#limits.maxRuns, this.#limits.maxRuns);
    const runs = this.#deps.runs.listByWorkspace(this.#deps.plan.workspaceId, limit);
    return {
      type: 'observation',
      content: { ok: true, runs: runs.map((run) => this.#runSummary(run)) },
    };
  }

  #getRun(input: Record<string, unknown>): ToolOutcome {
    const runId = asString(input['runId']);
    if (!runId) return toolError('BAD_INPUT', 'falta runId', 'sácalo de list_runs o del historial del plan');
    const run = this.#ownRun(runId);
    if (!run) {
      return toolError('NOT_FOUND', `el trabajo ${runId} no es de este workspace`,
        'list_runs enseña los que sí lo son');
    }
    const content: Record<string, unknown> = {
      ok: true,
      run: { ...this.#runSummary(run), strategy: run.strategy, strategyReason: run.strategyReason, cwd: run.cwd },
    };
    if (input['includeOutput'] === true) content['output'] = this.#tail(run);
    return { type: 'observation', content };
  }

  /** El final de lo que escribió el agente: lo justo para citar, con marca de recorte. */
  #tail(run: Run): { lines: Array<{ type: string; text: string }>; fromSeq: number; clipped: boolean } {
    const events: RunEvent[] = this.#deps.runs.events(run.id, -1);
    const interesting = events.filter((event) =>
      event.type === 'agent.text' || event.type === 'agent.error' || event.type === 'agent.result');
    const tail = interesting.slice(-this.#limits.maxRunEvents);
    let clipped = tail.length < interesting.length;
    const lines = tail.map((event) => {
      const payload = (event.payload ?? {}) as { text?: string | null; message?: string };
      const raw = payload.text ?? payload.message ?? '';
      const text = clip(raw, this.#limits.maxTextChars);
      if (text.truncated) clipped = true;
      return { type: event.type, text: text.text };
    });
    return { lines, fromSeq: tail[0]?.seq ?? 0, clipped };
  }

  #runSummary(run: Run): Record<string, unknown> {
    return {
      runId: run.id,
      status: run.status,
      permissionProfile: run.permissionProfile,
      executionHost: run.executionHost,
      workHost: run.workHost,
      createdAt: run.createdAt,
      finishedAt: run.finishedAt,
      resultSummary: clip(run.resultSummary, this.#limits.maxTextChars).text || null,
      errorCode: run.errorCode,
      errorMessage: clip(run.errorMessage, 300).text || null,
    };
  }

  #ownRun(runId: string): Run | null {
    const run = this.#deps.runs.find(runId);
    // Un plan sólo ve el trabajo de su propio workspace. Aislar aquí es más barato que confiar.
    return run && run.workspaceId === this.#deps.plan.workspaceId ? run : null;
  }

  // ---- efectos cortos -----------------------------------------------------

  async #cancelRun(input: Record<string, unknown>): Promise<ToolOutcome> {
    const runId = asString(input['runId']);
    if (!runId) return toolError('BAD_INPUT', 'falta runId');
    const run = this.#ownRun(runId);
    if (!run) return toolError('NOT_FOUND', `el trabajo ${runId} no es de este workspace`);
    const cancelled = await this.#deps.runs.cancel(runId, this.#deps.user, `plan:${this.#deps.plan.id}`);
    this.#deps.audit.record({
      actorUser: this.#deps.user.username,
      eventType: 'assistant.run_cancelled',
      workspaceId: this.#deps.plan.workspaceId,
      runId,
      payload: { planId: this.#deps.plan.id, reason: clip(asString(input['reason']), 200).text },
    });
    return { type: 'observation', content: { ok: true, run: this.#runSummary(cancelled) } };
  }

  /**
   * Ofrecer no es hacer.
   *
   * La oferta viaja con el plan y la interfaz la enseña como un botón; la tmux sólo existe si la
   * persona pulsa. Que el coordinador pudiera abrir sesiones vivas por su cuenta convertiría
   * «te lo dejo mirando» en «te abrí cuatro terminales».
   */
  #offerTerminal(input: Record<string, unknown>): ToolOutcome {
    const reason = asString(input['reason']);
    if (!reason) return toolError('BAD_INPUT', 'falta reason', 'di en una frase por qué conviene mirarlo en vivo');
    const { workspace } = this.#deps;
    this.#terminalOffer = {
      host: workspace.ref.host,
      provider: workspace.ref.provider,
      sessionId: workspace.ref.sessionId,
      cwd: workspace.cwd,
      permissionProfile: asProfile(input['permissionProfile'], 'safe'),
      reason: clip(reason, 300).text,
    };
    return {
      type: 'observation',
      content: { ok: true, offered: this.#terminalOffer, note: 'la abre la persona, no tú' },
    };
  }

  // ---- decisiones ---------------------------------------------------------

  #createRun(input: Record<string, unknown>): ToolOutcome {
    const prompt = asString(input['prompt']);
    if (!prompt) return toolError('BAD_INPUT', 'falta prompt', 'di qué tiene que hacer el agente');
    const profile = asProfile(input['permission_profile'], 'safe');
    if (profile === 'yolo') {
      return toolError('FORBIDDEN', 'sin restricciones no se concede por esta vía',
        'pídelo con request_approval, que enseña qué se va a ejecutar y caduca');
    }
    return {
      type: 'decision',
      decision: {
        kind: 'run',
        title: clip(asString(input['title']) ?? 'paso', 120).text,
        prompt,
        permissionProfile: profile,
        rationale: clip(asString(input['rationale']), 300).text,
      },
    };
  }

  #requestApproval(input: Record<string, unknown>): ToolOutcome {
    const prompt = asString(input['prompt']);
    const summary = asString(input['summary']);
    if (!prompt || !summary) {
      return toolError('BAD_INPUT', 'faltan summary o prompt',
        'lo que se aprueba es exactamente lo que dice el resumen; sin él no hay nada que leer');
    }
    return {
      type: 'decision',
      decision: {
        kind: 'approval',
        title: clip(asString(input['title']) ?? 'aprobación', 120).text,
        actionType: 'run',
        summary: clip(summary, 600).text,
        permissionProfile: asProfile(input['permission_profile'], 'auto'),
        prompt,
      },
    };
  }

  #askHuman(input: Record<string, unknown>): ToolOutcome {
    const question = asString(input['question']);
    if (!question) return toolError('BAD_INPUT', 'falta question');
    return {
      type: 'decision',
      decision: {
        kind: 'ask',
        title: clip(asString(input['title']) ?? 'pregunta', 120).text,
        question: clip(question, 600).text,
      },
    };
  }

  #finish(input: Record<string, unknown>): ToolOutcome {
    const summary = asString(input['summary']);
    if (!summary) return toolError('BAD_INPUT', 'falta summary', 'la síntesis es lo único que queda escrito del plan');
    const cited = Array.isArray(input['evidence_run_ids']) ? input['evidence_run_ids'] as unknown[] : [];
    // Se citan sólo los trabajos que existen y son de este workspace: una referencia rota en la
    // síntesis es peor que ninguna.
    const evidenceRunIds = cited
      .map((value) => asString(value))
      .filter((value): value is string => value !== null && this.#ownRun(value) !== null);
    return {
      type: 'decision',
      decision: { kind: 'finish', summary: clip(summary, 4000).text, evidenceRunIds },
    };
  }
}
