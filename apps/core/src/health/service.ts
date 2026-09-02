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

export interface HealthServiceDeps {
  db: Db;
  clock: Clock;
  fleet: FleetService;
  index: SessionIndex;
  runs: RunRepository;
  version: string;
}

export class HealthService {
  readonly #deps: HealthServiceDeps;
  #lastSweepAt: string | null = null;

  constructor(deps: HealthServiceDeps) {
    this.#deps = deps;
  }

  noteSweep(at: string): void { this.#lastSweepAt = at; }

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
    };
  }
}
