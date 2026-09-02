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
import { FleetService } from './fleet/service.js';
import { RunRepository } from './runs/repository.js';
import { RunEventBus } from './runs/events-bus.js';
import { RemoteRunner } from './runs/remote-runner.js';
import { RunService } from './runs/service.js';
import { RunSupervisor } from './runs/supervisor.js';
import { AttachmentService } from './attachments/service.js';
import { UsageService } from './usage/service.js';
import { HealthService } from './health/service.js';
import { TerminalService } from './terminal/service.js';

export const VERSION = '0.1.0';

export interface CoreServices {
  config: CoreConfig;
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
  attachments: AttachmentService;
  usage: UsageService;
  health: HealthService;
  terminal: TerminalService;
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

  const runs = new RunService({
    repository: runRepository, runner, workspaces, capabilities, bus, audit, clock, sshConfig, attachments,
    limits: {
      maxConcurrentRuns: config.maxConcurrentRuns,
      defaultPermissionProfile: config.defaultPermissionProfile,
      allowYolo: config.allowYolo,
      runTimeoutMs: config.runTimeoutMs,
      maxToolOutputBytes: config.maxToolOutputBytes,
      maxEventTextBytes: config.maxEventTextBytes,
      remotePath: config.remotePath,
    },
  });

  const supervisor = new RunSupervisor({
    runs, repository: runRepository, runner, clock,
    pollIntervalMs: config.pollIntervalMs,
    interruptGraceMs: config.interruptGraceMs,
    ...(options.onSupervisorError ? { onError: options.onSupervisorError } : {}),
  });

  const usage = new UsageService({ db, clock, sshConfig, ttlMs: config.usageTtlMs, probeTimeoutMs: config.usageProbeTimeoutMs });
  const health = new HealthService({ db, clock, fleet, index, runs: runRepository, version: VERSION });
  const terminal = new TerminalService({ sshConfig, clock, audit, capabilities, bastionHost: config.bastionHost });

  return {
    config, db, clock, sshConfig, audit, capabilities, workspaceRepository, workspaces,
    index, sessions, fleet, runRepository, runs, supervisor, attachments, usage, health, terminal,
    close() {
      supervisor.stop();
      db.close();
    },
  };
}
