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
import { ImportService } from './import/service.js';
import { OpenAiCompatibleTitleModel, TitleService } from './workspaces/title.js';
import { MetricsService } from './metrics/service.js';
import { AlertService } from './alerts/service.js';
import { HealthWatch, runAlert } from './alerts/watch.js';

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
  imports: ImportService;
  titles: TitleService;
  metrics: MetricsService;
  alerts: AlertService;
  /** Avisa cuando la salud cambia; arranca con `main.ts`, no al construir. */
  healthWatch: HealthWatch;
  close(): void;
}

export interface BuildServicesOptions {
  config?: Partial<CoreConfig>;
  clock?: Clock;
  index?: SessionIndex;
  db?: Db;
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
  const runRepository = new RunRepository(db);
  const sessions = new SessionService({
    index, workspaces: workspaceRepository, clock, bastionHost: config.bastionHost,
    modelsUsed: () => runRepository.modelsUsed(),
  });
  const fleet = new FleetService({ db, clock, capabilities, hosts: config.hosts, bastionHost: config.bastionHost });

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

  const usage = new UsageService({ db, clock, sshConfig, ttlMs: config.usageTtlMs, probeTimeoutMs: config.usageProbeTimeoutMs });
  const metrics = new MetricsService({ db, clock });
  const health = new HealthService({ db, clock, fleet, index, runs: runRepository, version: VERSION });
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
  // en la ruta.
  runs.onRunFinished = (run, prompt) => {
    void titles.nameFromRun(run.workspaceId, { prompt, resultSummary: run.resultSummary })
      .catch(() => undefined);
    // Y avisar. El nombre se lee antes de que el título nuevo llegue, que va en segundo plano: el
    // de ahora es el que la persona reconoce, porque es el que estaba viendo.
    if (config.alertsRuns) {
      runAlert(run, workspaceRepository.findById(run.workspaceId)?.title ?? null, alerts,
        (host) => (host === config.bastionHost ? config.alertsSelfHost : host));
    }
  };

  /**
   * Las alertas: la bandeja, el envío push y lo que Jarvis cuenta por su cuenta.
   *
   * La máquina de origen de lo que nace aquí es la del core, con el nombre que la reconoce quien
   * lee (`alertsSelfHost`), no con su alias de la flota.
   */
  const alerts = new AlertService({
    db, clock,
    pushSubject: config.pushSubject,
    vapidKeys: config.pushVapidPublicKey && config.pushVapidPrivateKey
      ? { publicKey: config.pushVapidPublicKey, privateKey: config.pushVapidPrivateKey }
      : null,
    apiPerMinute: config.alertsApiPerMinute,
    retentionDays: config.alertsRetentionDays,
    maxStored: config.alertsMaxStored,
    onWarn: (message) => console.warn(`[alerts] ${message}`),
  });
  const healthWatch = new HealthWatch({
    snapshot: () => health.snapshot({ probeHosts: true }),
    alerts, host: config.alertsSelfHost, intervalMs: config.alertsHealthWatchMs,
  });

  return {
    config, db, clock, sshConfig, audit, capabilities, workspaceRepository, workspaces, cwdResolver,
    index, sessions, fleet, runRepository, runs, supervisor, attachments, usage, health, terminal,
    retention, imports, titles, metrics, alerts, healthWatch,
    close() {
      supervisor.stop();
      retention.stop();
      healthWatch.stop();
      db.close();
    },
  };
}
