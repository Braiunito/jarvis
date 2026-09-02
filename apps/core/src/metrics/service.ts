/**
 * Métricas del panel.
 *
 * Se calculan con SQL sobre lo que ya está confirmado, no contando a ojo en el navegador: el
 * cliente sólo tiene los últimos cincuenta runs y de ahí no sale un «12% menos que la semana
 * pasada» que se pueda creer.
 *
 * Nada de esto sale de la máquina: son agregados locales para pintar una pantalla.
 */
import type { Database as Db } from 'better-sqlite3';
import type { Provider, RunStatus } from '@jarvis/contracts';
import type { Clock } from '../platform/clock.js';

export interface ActivityBucket {
  /** Comienzo del intervalo, en ISO. */
  at: string;
  runs: number;
  failed: number;
}

export interface MetricsSnapshot {
  window: { hours: number; from: string; to: string };
  runs: {
    total: number;
    /** Mismo periodo inmediatamente anterior, para poder decir si sube o baja. */
    previousTotal: number;
    deltaPercent: number | null;
    active: number;
    needsAttention: number;
    byProvider: Array<{ provider: Provider; runs: number; percent: number }>;
    byStatus: Array<{ status: RunStatus; runs: number }>;
    totalDurationMs: number;
    medianDurationMs: number | null;
    buckets: ActivityBucket[];
  };
  /**
   * La cuota que ya se sabe, sin tocar la red.
   *
   * Se lee de los snapshots persistidos —los que dejan el sondeo y los propios trabajos— y se
   * queda con la ventana más apretada de cada cuenta, que es la que decide si conviene lanzar algo
   * ahora. Sirve para enseñarla donde también se decide trabajar y no sólo dentro de un workspace.
   */
  usage: Array<{
    provider: string;
    executionHost: string;
    plan: string | null;
    label: string;
    remainingPercent: number;
    resetsAt: string | null;
    fetchedAt: string;
    stale: boolean;
  }>;
  workspaces: { total: number; openedInWindow: number };
  plans: { active: number; waitingApproval: number };
  /** Terminales vivas, para el aviso de la navegación. Es lo último conocido, no una sonda. */
  terminals: { open: number; byHost: Array<{ host: string; open: number }>; at: string | null; stale: boolean };
}

const ACTIVE_STATUSES = ['queued', 'preparing', 'running', 'waiting', 'cancelling'];
const ATTENTION_STATUSES = ['failed', 'timed_out', 'waiting'];

export class MetricsService {
  readonly #db: Db;
  readonly #clock: Clock;

  /** De dónde sale el número de terminales. Es un gancho: las métricas no abren conexiones. */
  terminals: (() => { open: number; byHost: Array<{ host: string; open: number }>; at: string | null; stale: boolean }) | null = null;

  constructor({ db, clock }: { db: Db; clock: Clock }) {
    this.#db = db;
    this.#clock = clock;
  }

  snapshot({ hours = 24, buckets = 24 }: { hours?: number; buckets?: number } = {}): MetricsSnapshot {
    const now = this.#clock.nowMs();
    const from = new Date(now - hours * 3600_000).toISOString();
    const previousFrom = new Date(now - 2 * hours * 3600_000).toISOString();
    const to = new Date(now).toISOString();

    const count = (sql: string, ...params: unknown[]): number =>
      (this.#db.prepare(sql).get(...params) as { n: number }).n;

    const total = count('SELECT COUNT(*) AS n FROM runs WHERE created_at >= ?', from);
    const previousTotal = count(
      'SELECT COUNT(*) AS n FROM runs WHERE created_at >= ? AND created_at < ?', previousFrom, from,
    );

    const byProviderRows = this.#db.prepare(
      'SELECT provider, COUNT(*) AS n FROM runs WHERE created_at >= ? GROUP BY provider ORDER BY n DESC',
    ).all(from) as Array<{ provider: Provider; n: number }>;

    const byStatusRows = this.#db.prepare(
      'SELECT status, COUNT(*) AS n FROM runs WHERE created_at >= ? GROUP BY status',
    ).all(from) as Array<{ status: RunStatus; n: number }>;

    // Duración de lo que ya terminó: un run en marcha todavía no tiene una duración que contar.
    const durations = (this.#db.prepare(`
      SELECT (julianday(finished_at) - julianday(COALESCE(started_at, created_at))) * 86400000 AS ms
      FROM runs
      WHERE created_at >= ? AND finished_at IS NOT NULL
      ORDER BY ms
    `).all(from) as Array<{ ms: number }>).map((row) => Math.max(0, Math.round(row.ms)));

    const totalDurationMs = durations.reduce((sum, ms) => sum + ms, 0);
    const medianDurationMs = durations.length
      ? durations[Math.floor(durations.length / 2)] ?? null
      : null;

    return {
      window: { hours, from, to },
      runs: {
        total,
        previousTotal,
        // Sin nada con qué comparar no se inventa un porcentaje: se dice que no se sabe.
        deltaPercent: previousTotal === 0
          ? (total === 0 ? 0 : null)
          : Math.round(((total - previousTotal) / previousTotal) * 100),
        active: count(
          `SELECT COUNT(*) AS n FROM runs WHERE status IN (${ACTIVE_STATUSES.map(() => '?').join(',')})`,
          ...ACTIVE_STATUSES,
        ),
        // Lo que todavía pide algo: un trabajo dado por visto deja de contar, aunque siga fallido.
        needsAttention: count(
          `SELECT COUNT(*) AS n FROM runs WHERE status IN (${ATTENTION_STATUSES.map(() => '?').join(',')})`
          + ' AND created_at >= ? AND acknowledged_at IS NULL',
          ...ATTENTION_STATUSES, previousFrom,
        ),
        byProvider: byProviderRows.map((row) => ({
          provider: row.provider,
          runs: row.n,
          percent: total ? Math.round((row.n / total) * 100) : 0,
        })),
        byStatus: byStatusRows.map((row) => ({ status: row.status, runs: row.n })),
        totalDurationMs,
        medianDurationMs,
        buckets: this.#buckets({ now, hours, buckets }),
      },
      usage: this.#usage(),
      workspaces: {
        total: count('SELECT COUNT(*) AS n FROM workspaces'),
        openedInWindow: count('SELECT COUNT(*) AS n FROM workspaces WHERE last_opened_at >= ?', from),
      },
      terminals: this.terminals?.() ?? { open: 0, byHost: [], at: null, stale: true },
      plans: {
        active: count("SELECT COUNT(*) AS n FROM plans WHERE status NOT IN ('completed','failed','cancelled')"),
        waitingApproval: count("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'"),
      },
    };
  }

  /** El histograma de actividad: un intervalo por barra, incluidos los vacíos. */
  /**
   * La ventana más apretada de cada cuenta.
   *
   * Un snapshot trae varias —sesión, cinco horas, semana— y en una lista general sólo cabe una:
   * la que primero va a molestar. Las demás siguen en el workspace, que es donde se mira el
   * detalle. No toca la red: lee lo que dejaron el sondeo y los propios trabajos.
   */
  #usage(): MetricsSnapshot['usage'] {
    const rows = this.#db.prepare(
      'SELECT provider, execution_host, account_json, limits_json, fetched_at, refresh_error FROM usage_snapshots',
    ).all() as Array<{
      provider: string; execution_host: string; account_json: string | null;
      limits_json: string; fetched_at: string; refresh_error: string | null;
    }>;

    const out: MetricsSnapshot['usage'] = [];
    for (const row of rows) {
      let limits: Array<{ label: string; remainingPercent: number; resetsAt: string | null }> = [];
      let plan: string | null = null;
      try {
        limits = JSON.parse(row.limits_json) as typeof limits;
        plan = (JSON.parse(row.account_json ?? 'null') as { plan?: string } | null)?.plan ?? null;
      } catch {
        // Un snapshot ilegible no puede tumbar el panel: se salta y ya.
        continue;
      }
      const tightest = limits.reduce<(typeof limits)[number] | null>(
        (worst, limit) => (!worst || limit.remainingPercent < worst.remainingPercent ? limit : worst),
        null,
      );
      if (!tightest) continue;
      out.push({
        provider: row.provider,
        executionHost: row.execution_host,
        plan,
        label: tightest.label,
        remainingPercent: tightest.remainingPercent,
        resetsAt: tightest.resetsAt ?? null,
        fetchedAt: row.fetched_at,
        stale: row.refresh_error !== null,
      });
    }
    return out.sort((a, b) => a.remainingPercent - b.remainingPercent);
  }

  #buckets({ now, hours, buckets }: { now: number; hours: number; buckets: number }): ActivityBucket[] {
    const spanMs = (hours * 3600_000) / buckets;
    const rows = this.#db.prepare(`
      SELECT created_at, status FROM runs WHERE created_at >= ?
    `).all(new Date(now - hours * 3600_000).toISOString()) as Array<{ created_at: string; status: string }>;

    const series: ActivityBucket[] = [];
    for (let index = 0; index < buckets; index += 1) {
      const start = now - (buckets - index) * spanMs;
      series.push({ at: new Date(start).toISOString(), runs: 0, failed: 0 });
    }
    for (const row of rows) {
      const offset = Date.parse(row.created_at) - (now - hours * 3600_000);
      const index = Math.min(buckets - 1, Math.max(0, Math.floor(offset / spanMs)));
      const bucket = series[index];
      if (!bucket) continue;
      bucket.runs += 1;
      if (row.status === 'failed' || row.status === 'timed_out') bucket.failed += 1;
    }
    return series;
  }
}
