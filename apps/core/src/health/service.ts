/**
 * Salud por salto.
 *
 * `GET /api/health` no devuelve `ok: true/false`. Que un host no responda deja ese check en
 * `failed` y todo lo demás usable: la UI necesita saber el alcance del problema, no que la
 * aplicación entera se declare caída.
 */
import type { Database as Db } from 'better-sqlite3';
import type { Health, HealthCheck } from '@jarvis/contracts';
import { integrityCheck } from '../platform/db.js';
import type { Clock } from '../platform/clock.js';
import type { FleetService } from '../fleet/service.js';
import type { SessionIndex } from '../sessions/index-client.js';
import type { RunRepository } from '../runs/repository.js';
import type { McpService } from '../mcp/service.js';

export interface HealthServiceDeps {
  db: Db;
  clock: Clock;
  fleet: FleetService;
  index: SessionIndex;
  runs: RunRepository;
  /** Las capacidades MCP, si las hay. Opcional: sin servidores no hay salto que comprobar. */
  mcp?: McpService;
  version: string;
}

/** Cuándo arrancó este proceso: es lo que convierte «uptime» en un dato y no en una sensación. */
const STARTED_AT = new Date();

export class HealthService {
  readonly #deps: HealthServiceDeps;
  #lastSweepAt: string | null = null;
  #lastRetentionAt: string | null = null;
  #lastRetention: { compactedEvents: number; droppedEvents: number; bytesFreed: number } | null = null;

  constructor(deps: HealthServiceDeps) {
    this.#deps = deps;
  }

  noteSweep(at: string): void { this.#lastSweepAt = at; }

  /**
   * Lo mismo para la retención de eventos (ADR-007), y con el mismo motivo.
   *
   * Se guarda además lo que hizo la última pasada: un barrido que dice «ok» sin decir cuánto
   * limpió no distingue «no hacía falta» de «no encontró nada porque está roto».
   */
  noteRetention(at: string, report: { compactedEvents: number; droppedEvents: number; bytesFreed: number }): void {
    this.#lastRetentionAt = at;
    this.#lastRetention = report;
  }

  async snapshot({ probeHosts = true }: { probeHosts?: boolean } = {}): Promise<Health> {
    const checks: Record<string, HealthCheck> = {};

    try {
      const result = integrityCheck(this.#deps.db);
      checks['database'] = result === 'ok'
        ? { status: 'ok' }
        : { status: 'failed', code: 'DB_CORRUPT', message: result };
    } catch (error) {
      checks['database'] = { status: 'failed', code: 'DB_UNAVAILABLE', message: (error as Error).message };
    }

    const index = await this.#deps.index.health();
    checks['aisessions'] = index.ok
      ? { status: 'ok', lastOkAt: index.lastOkAt }
      : { status: index.lastOkAt ? 'stale' : 'failed', code: 'INDEX_UNAVAILABLE', message: index.error ?? undefined, lastOkAt: index.lastOkAt };

    /*
     * Los servidores MCP, uno por salto.
     *
     * Un catálogo que no se puede pedir deja al asistente sin capacidades, y eso hoy se notaría
     * como «el asistente contesta peor» en vez de como una avería. Aquí se ve por lo que es. Que
     * uno esté caído no invalida al resto ni a nada más: es exactamente el mismo criterio que con
     * los hosts.
     */
    if (this.#deps.mcp?.configured) {
      for (const server of await this.#deps.mcp.states()) {
        checks[`mcp:${server.name}`] = server.status === 'ok'
          ? {
            status: 'ok',
            ...(server.lastOkAt ? { lastOkAt: server.lastOkAt } : {}),
            detail: { tools: server.toolCount, writes: server.writesAllowed, server: server.serverInfo },
          }
          : {
            status: server.status === 'stale' ? 'stale' : 'failed',
            code: 'UPSTREAM_UNAVAILABLE',
            ...(server.lastError ? { message: server.lastError } : {}),
            ...(server.lastOkAt ? { lastOkAt: server.lastOkAt } : {}),
          };
      }
    }

    if (probeHosts) {
      for (const host of await this.#deps.fleet.list()) {
        checks[`ssh:${host.host}`] = host.reachable
          ? { status: host.stale ? 'stale' : 'ok', lastOkAt: host.probedAt, detail: { providers: host.providers, tmux: host.tmux } }
          : { status: 'failed', code: 'HOST_UNREACHABLE', message: host.error ?? undefined, lastOkAt: host.probedAt };
      }
    }

    // Un run que lleva demasiado tiempo en `cancelling` es exactamente lo que hay que ver aquí:
    // significa que no pudimos confirmar que el proceso remoto parase.
    const stuck = this.#deps.runs.listByStatus(['cancelling']).filter((run) => {
      const since = run.cancelRequestedAt ? Date.parse(run.cancelRequestedAt) : this.#deps.clock.nowMs();
      return this.#deps.clock.nowMs() - since > 60_000;
    });
    checks['runs'] = stuck.length
      ? { status: 'degraded', code: 'CANCEL_UNCONFIRMED', message: `${stuck.length} run(s) waiting for cancellation to be confirmed`, detail: { runIds: stuck.map((run) => run.id) } }
      : { status: 'ok', detail: { active: this.#deps.runs.countActive() } };

    checks['runnerSweep'] = { status: this.#lastSweepAt ? 'ok' : 'unknown', lastAt: this.#lastSweepAt };
    checks['eventRetention'] = {
      status: this.#lastRetentionAt ? 'ok' : 'unknown',
      lastAt: this.#lastRetentionAt,
      ...(this.#lastRetention ? { detail: { ...this.#lastRetention } } : {}),
    };

    const statuses = Object.values(checks).map((check) => check.status);
    const status: Health['status'] = statuses.includes('failed')
      ? (checks['database']?.status === 'failed' ? 'failed' : 'degraded')
      : statuses.some((value) => value === 'degraded' || value === 'stale') ? 'degraded' : 'ok';

    return {
      status,
      service: 'jarvis-core',
      version: this.#deps.version,
      at: this.#deps.clock.nowIso(),
      checks,
      system: {
        startedAt: STARTED_AT.toISOString(),
        uptimeSeconds: Math.max(0, Math.round((this.#deps.clock.nowMs() - STARTED_AT.getTime()) / 1000)),
        node: process.version,
        sqlite: (this.#deps.db.prepare('select sqlite_version() as v').get() as { v: string }).v,
        hosts: this.#deps.fleet.hosts.length,
        bastionHost: this.#deps.fleet.bastionHost,
      },
    };
  }
}
