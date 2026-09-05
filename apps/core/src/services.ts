/**
 * Composición explícita.
 *
 * Todas las dependencias se construyen aquí, a la vista: no hay service locator, ni decorators,
 * ni un bus global que resuelva cosas en tiempo de ejecución. Quien lee este fichero sabe qué
 * depende de qué.
 */
import type { Database as Db } from 'better-sqlite3';
import { CapabilityCache, defaultSshConfig, type SshConfig } from '@jarvis/agent-adapters';
import { config as defaultConfig, type CoreConfig } from './config.js';
import { migrate, openDatabase } from './platform/db.js';
import { systemClock, type Clock } from './platform/clock.js';
import { AuditLog } from './platform/audit.js';
import { WorkspaceRepository } from './workspaces/repository.js';
import { WorkspaceService } from './workspaces/use-cases.js';
import { HttpSessionIndex, type SessionIndex } from './sessions/index-client.js';
import { SessionService } from './sessions/service.js';
import { CwdResolver } from './sessions/cwd-resolver.js';
import { EvidenceService } from './evidence/service.js';
import { FleetService } from './fleet/service.js';
import { RunRepository } from './runs/repository.js';
import { RunEventBus } from './runs/events-bus.js';
import { RemoteRunner } from './runs/remote-runner.js';
import { RunService } from './runs/service.js';
import { RunSupervisor } from './runs/supervisor.js';
import { RetentionSupervisor } from './runs/retention.js';
import { AttachmentService } from './attachments/service.js';
import { UsageService } from './usage/service.js';
import { HealthService } from './health/service.js';
import { TerminalService } from './terminal/service.js';
import {
  AnthropicModel, OpenAiCompatibleModel, ScriptedModel,
  type AssistantModel, type ModelTurnUsage,
} from './assistant/model.js';
import { HybridModel, LOCAL_SYSTEM_PROMPT } from './assistant/hybrid.js';
import { McpService } from './mcp/service.js';
import { parseMcpServers } from './mcp/config.js';
import { ChatService } from './chat/service.js';

/**
 * El cerebro de casa: un `llama-server` en el bastión, API compatible con OpenAI.
 *
 * Se le habla con `LOCAL_SYSTEM_PROMPT` y no con el de siempre porque un modelo pequeño rinde
 * distinto: lo que a uno grande le da matiz, a éste le ocupa el contexto que necesita para
 * razonar. Y con más plazo, porque genera a unos 7 tokens por segundo y una API no.
 */
function buildLocalModel(config: CoreConfig): AssistantModel | null {
  if (!config.localModelBaseUrl) return null;
  return new OpenAiCompatibleModel({
    apiKey: config.localModelApiKey,
    baseUrl: config.localModelBaseUrl,
    model: config.localModelName || 'local',
    maxToolCalls: config.assistantMaxToolCalls,
    timeoutMs: config.localModelTimeoutMs,
    systemPrompt: LOCAL_SYSTEM_PROMPT,
    /*
     * Lo que se le devuelve de una herramienta va corto.
     *
     * El tope de siempre —60.000 caracteres— son unos 15.000 tokens: el contexto entero de este
     * modelo por una sola observación. Y aunque cupiera, el turno que redacta lleva ese texto
     * dentro y es donde se va el 70 % del tiempo de respuesta.
     */
    maxToolResultChars: config.localModelToolResultChars,
    maxOutputTokens: config.localModelMaxOutputTokens,
    maxOutputTokensParam: config.localModelMaxTokensParam,
    /*
     * La temperatura y el esfuerzo de razonamiento sólo se mandan si están puestos.
     *
     * No es prudencia genérica: un modelo que razona rechaza la petición entera si le llega una
     * temperatura que no sea la suya. Mandar un parámetro de más aquí no degrada nada, tumba el
     * asistente.
     */
    ...(config.localModelTemperature !== '' ? { temperature: Number(config.localModelTemperature) } : {}),
    ...(config.localModelReasoningEffort ? { reasoningEffort: config.localModelReasoningEffort } : {}),
    /*
     * Con `JARVIS_VERBOSE` se dice dónde se va el tiempo de cada vuelta.
     *
     * `caché` es lo que el servidor NO tuvo que volver a leer. Si ese número es bajo en la segunda
     * vuelta de un turno, se está pagando el prompt entero cada vez y el problema está en el
     * servidor, no en el modelo.
     */
    ...(config.verbose ? {
      onUsage: (usage: ModelTurnUsage) => console.log(
        `[jarvis] modelo local · ${usage.elapsedMs} ms · prompt ${usage.promptTokens}`
        + ` (caché ${usage.cachedTokens}) · generados ${usage.completionTokens}`,
      ),
    } : {}),
  });
}

/**
 * A dónde se escala, según el proveedor configurado.
 *
 * Un solo sitio donde se decide, porque el fallo que evita es el que no se ve: una credencial
 * puesta y un Assistant que sigue sin funcionar porque el core habla otro protocolo.
 */
function buildCloudModel(config: CoreConfig): AssistantModel | null {
  if (!config.cloudModelApiKey) return null;
  const options = {
    apiKey: config.cloudModelApiKey,
    baseUrl: config.cloudModelBaseUrl,
    model: config.cloudModelName,
    maxToolCalls: config.assistantMaxToolCalls,
    // Sin tope salvo que alguien lo pida: ver `cloudModelMaxOutputTokens`.
    ...(config.cloudModelMaxOutputTokens ? {
      maxOutputTokens: config.cloudModelMaxOutputTokens,
      maxOutputTokensParam: config.cloudModelMaxTokensParam,
    } : {}),
  };
  return config.cloudModelProvider === 'anthropic'
    ? new AnthropicModel(options)
    : new OpenAiCompatibleModel(options);
}
import { PlanService } from './plans/service.js';
import { PlanSupervisor } from './plans/supervisor.js';
import { ImportService } from './import/service.js';
import { OpenAiCompatibleTitleModel, TitleService } from './workspaces/title.js';
import { MetricsService } from './metrics/service.js';

export const VERSION = '0.1.0';

export interface CoreServices {
  config: CoreConfig;
  /** Encuentra el directorio de una sesión que no lo tenía guardado (TEC-11). */
  cwdResolver: CwdResolver;
  db: Db;
  clock: Clock;
  sshConfig: SshConfig;
  audit: AuditLog;
  capabilities: CapabilityCache;
  workspaceRepository: WorkspaceRepository;
  workspaces: WorkspaceService;
  index: SessionIndex;
  sessions: SessionService;
  fleet: FleetService;
  runRepository: RunRepository;
  runs: RunService;
  supervisor: RunSupervisor;
  retention: RetentionSupervisor;
  attachments: AttachmentService;
  usage: UsageService;
  health: HealthService;
  terminal: TerminalService;
  plans: PlanService;
  planSupervisor: PlanSupervisor;
  /** Las capacidades MCP que este core consume (ADR-009). */
  mcp: McpService;
  chat: ChatService;
  imports: ImportService;
  titles: TitleService;
  metrics: MetricsService;
  close(): void;
}

export interface BuildServicesOptions {
  config?: Partial<CoreConfig>;
  clock?: Clock;
  index?: SessionIndex;
  db?: Db;
  /** Sólo para tests y desarrollo: un modelo determinista en vez del de verdad. */
  model?: AssistantModel | null;
  /**
   * Un MCP ya construido, igual que `index`.
   *
   * Existe por el mismo motivo que aquél: probar el asistente contra capacidades de verdad exigiría
   * un servidor MCP levantado, y lo que hay que probar aquí es el core, no el servidor de otro.
   */
  mcp?: McpService;
  onSupervisorError?: (error: Error, runId: string) => void;
}

export function buildServices(options: BuildServicesOptions = {}): CoreServices {
  const config = { ...defaultConfig, ...options.config } as CoreConfig;
  const clock = options.clock ?? systemClock;
  const db = options.db ?? openDatabase({ path: config.database });
  migrate(db);

  const sshConfig = defaultSshConfig({
    sshCommand: config.sshCommand,
    sshOptions: [...config.sshOptions],
    hosts: [...config.hosts],
    bastionHost: config.bastionHost,
    knownHostsFile: config.knownHostsFile,
    remotePath: config.remotePath,
  });

  const audit = new AuditLog(db, clock);
  const capabilities = new CapabilityCache({ config: sshConfig, ttlMs: config.capabilityTtlMs, now: () => clock.nowMs() });
  const workspaceRepository = new WorkspaceRepository(db);
  const workspaces = new WorkspaceService({ repository: workspaceRepository, clock, audit, bastionHost: config.bastionHost });

  const index = options.index ?? new HttpSessionIndex({
    baseUrl: config.indexUrl, token: config.indexToken, timeoutMs: config.indexTimeoutMs,
  });
  const sessions = new SessionService({ index, workspaces: workspaceRepository, clock, bastionHost: config.bastionHost });
  const fleet = new FleetService({ db, clock, capabilities, hosts: config.hosts, bastionHost: config.bastionHost });

  const runRepository = new RunRepository(db);
  const bus = new RunEventBus();
  const runner = new RemoteRunner({
    sshConfig, spoolRoot: config.spoolRoot, pollChunkBytes: config.pollChunkBytes,
  });
  const attachments = new AttachmentService({
    db, clock, sshConfig, root: config.attachmentRoot,
    maxBytes: config.attachmentMaxBytes, quotaBytes: config.attachmentQuotaBytes, ttlMs: config.attachmentTtlMs,
  });

  /**
   * Sesiones de Claude cuyo directorio el índice no trae: se deduce y se confirma contra la
   * máquina la primera vez que se lanza un trabajo sobre ellas (TEC-11).
   */
  const cwdResolver = new CwdResolver({
    sessions, sshConfig, now: () => clock.nowMs(),
    onWarn: (message) => console.warn(`[jarvis] ${message}`),
  });

  /** Ficheros y cambios del host, para que el Assistant vea la evidencia que no es texto (TEC-06). */
  const evidence = new EvidenceService({ sshConfig });

  const runs = new RunService({
    repository: runRepository, runner, workspaces, capabilities, bus, audit, clock, sshConfig, attachments,
    cwd: cwdResolver,
    limits: {
      maxConcurrentRuns: config.maxConcurrentRuns,
      defaultPermissionProfile: config.defaultPermissionProfile,
      allowYolo: config.allowYolo,
      runTimeoutMs: config.runTimeoutMs,
      maxToolOutputBytes: config.maxToolOutputBytes,
      maxEventTextBytes: config.maxEventTextBytes,
      remotePath: config.remotePath,
      spoolRoot: config.spoolRoot,
    },
  });

  const supervisor = new RunSupervisor({
    runs, repository: runRepository, runner, clock,
    pollIntervalMs: config.pollIntervalMs,
    interruptGraceMs: config.interruptGraceMs,
    lostGraceMs: config.lostGraceMs,
    // Para barrer hace falta saber a qué máquinas se puede llegar y dónde tienen su spool.
    capabilities, hosts: config.hosts, spoolRoot: config.spoolRoot,
    sweepIntervalMs: config.sweepIntervalMs,
    spoolRetentionDays: config.spoolRetentionDays,
    ...(options.onSupervisorError ? { onError: options.onSupervisorError } : {}),
  });

  /**
   * El asistente: el cerebro de casa, el de la nube, o los dos con una puerta entre medias.
   *
   * Los cuatro casos son válidos y ninguno rompe lo que había. Una instalación que sólo tenía
   * `JARVIS_MODEL_API_KEY` sigue funcionando exactamente igual —queda como cerebro de nube, sin
   * escalada, porque no hay dos sitios entre los que escalar—, y añadir el local no le quita nada:
   * le pone delante quien piensa gratis.
   */
  const localModel = buildLocalModel(config);
  const cloudModel = buildCloudModel(config);
  const hybrid = localModel || cloudModel ? new HybridModel({ local: localModel, cloud: cloudModel }) : null;
  const model = options.model !== undefined
    ? options.model
    : hybrid ?? (config.assistantScripted ? new ScriptedModel() : null);

  /**
   * Los servidores MCP declarados.
   *
   * Sin ninguno, `configured` es falso y el router de capacidades no se le ofrece al modelo: un
   * asistente que enumera lo que no puede hacer gasta el turno prometiendo.
   */
  const mcp = options.mcp ?? new McpService({
    servers: parseMcpServers({
      servers: config.mcpServers,
      tokens: config.mcpTokens,
      writeServers: config.mcpWriteServers,
      allow: config.mcpAllow,
      deny: config.mcpDeny,
    }),
    clock,
    audit,
    ttlMs: config.mcpTtlMs,
    timeoutMs: config.mcpTimeoutMs,
    maxOutputChars: config.mcpMaxOutputChars,
  });

  const usage = new UsageService({ db, clock, sshConfig, ttlMs: config.usageTtlMs, probeTimeoutMs: config.usageProbeTimeoutMs });
  const metrics = new MetricsService({ db, clock });
  const health = new HealthService({ db, clock, fleet, index, runs: runRepository, mcp, version: VERSION });
  /**
   * El barrido de spools le cuenta a Salud cuándo ocurrió.
   *
   * Se engancha aquí y no en el constructor del supervisor porque Salud se construye después; el
   * check `runnerSweep` existía desde el principio pero nadie lo alimentaba, y por eso la pantalla
   * decía «sin datos» para siempre.
   */
  supervisor.onSweep = (at) => health.noteSweep(at);

  // El contador de terminales vive en el servicio que sabe hablar con tmux; las métricas sólo lo
  // enseñan, y por eso es un gancho y no una dependencia: una consulta de panel no abre conexiones.
  metrics.terminals = () => terminal.openCount();
  const terminal = new TerminalService({
    sshConfig, clock, audit, capabilities, bastionHost: config.bastionHost, hosts: config.hosts,
  });
  const plans = new PlanService({
    db, clock, runs, workspaces, sessions, health, model, audit, attachments, evidence,
    maxToolCalls: config.assistantMaxToolCalls,
    // En un plan el MCP es de sólo lectura: su motor sólo sabe ejecutar runs (ADR-009).
    mcp,
    canEscalate: hybrid?.canEscalate === true,
    starterCapabilities: config.mcpStarter,
  });

  /**
   * La conversación.
   *
   * Toma el mismo modelo y las mismas herramientas que el plan, y se diferencia en lo que sabe
   * ejecutar: además de lanzar trabajo, puede ejecutar una capacidad del sistema cuando hay una
   * aprobación firmada detrás.
   */
  const chat = new ChatService({
    db, clock, runs, workspaces, sessions, health, audit,
    model: options.model !== undefined
      ? (options.model instanceof HybridModel ? options.model : null)
      : hybrid,
    mcp, attachments, evidence,
    maxToolCalls: config.chatMaxToolCalls,
    maxTurnMs: config.chatMaxTurnMs,
    directCapabilities: config.chatDirectCapabilities,
    maxTools: config.chatMaxTools,
    historyMessages: config.chatHistoryMessages,
    defaultAutonomy: config.chatDefaultAutonomy,
    starterCapabilities: config.mcpStarter,
  });
  /*
   * Un turno de chat vive en memoria, así que un reinicio deja conversaciones «pensando» que no
   * vuelven solas. Se cierran al arrancar, diciendo qué pasó: es el equivalente conversacional de
   * reconciliar un run, sólo que aquí no hay nada que adoptar —el turno no dejó rastro fuera—.
   */
  const stuck = chat.reconcile();
  if (stuck > 0) console.warn(`[jarvis] ${stuck} conversación(es) se quedaron pensando en el arranque anterior`);

  const planSupervisor = new PlanSupervisor({ plans, intervalMs: config.planIntervalMs });

  /**
   * La retención de eventos (ADR-007), que a diferencia del barrido de spools no necesita que
   * ninguna máquina responda: la base es local y se limpia aunque la flota esté apagada entera.
   */
  const retention = new RetentionSupervisor({
    db, clock, intervalMs: config.retentionIntervalMs,
    policy: {
      compactAfterDays: config.eventCompactAfterDays,
      dropAfterDays: config.eventDropAfterDays,
      summaryChars: config.eventSummaryChars,
    },
  });
  retention.onSweep = (at, report) => health.noteRetention(at, report);
  const imports = new ImportService({ db, clock, workspaces: workspaceRepository, audit, bastionHost: config.bastionHost });
  const titles = new TitleService({
    perMinute: config.titlePerMinute,
    db,
    clock,
    model: config.titleApiKey
      ? new OpenAiCompatibleTitleModel({
        apiKey: config.titleApiKey, baseUrl: config.titleBaseUrl, model: config.titleModel,
      })
      : null,
  });
  /**
   * La cuota se aprende del propio trabajo: cada ejecución de Claude cuenta cuánto le queda a la
   * cuenta, y eso es más fresco —y mucho más barato— que el sondeo que abre un TTY y raspa una
   * pantalla, que además depende de la versión del CLI que haya en cada máquina.
   */
  runs.onQuota = (quota) => {
    try {
      usage.recordFromAgent(quota);
    } catch {
      // Un extra que llega dentro del stream de un run no puede estropear el run.
    }
  };

  // Nombrar el workspace es consecuencia de que un trabajo termine, así que se engancha ahí y no
  // en la ruta: da igual si el run lo lanzó una persona o el Assistant.
  runs.onRunFinished = (run, prompt) => {
    void titles.nameFromRun(run.workspaceId, { prompt, resultSummary: run.resultSummary })
      .catch(() => undefined);
  };

  return {
    config, db, clock, sshConfig, audit, capabilities, workspaceRepository, workspaces, cwdResolver,
    index, sessions, fleet, runRepository, runs, supervisor, attachments, usage, health, terminal,
    plans, planSupervisor, retention, imports, titles, metrics, mcp, chat,
    close() {
      supervisor.stop();
      planSupervisor.stop();
      retention.stop();
      db.close();
    },
  };
}
