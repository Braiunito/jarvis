/**
 * La cola de trabajo durable, con un solo consumidor.
 *
 * No es una cola distribuida y no pretende serlo: es el **registro de que alguien pidió algo**.
 * Un turno de chat vive hoy en un `Map` en memoria, así que entre que la persona escribe y el
 * modelo contesta hay una ventana en la que lo que pidió no existe en ningún sitio. `reconcile()`
 * puede decir que ese turno se perdió, pero no puede saber que había que hacerlo.
 *
 * Dos invariantes viven aquí y en ningún otro sitio:
 *
 *   · **Un trabajo vivo por recurso**, y lo impone la base con un índice único parcial: dos
 *     `send()` seguidos sobre la misma conversación no pueden dejar dos turnos encolados.
 *   · **La marca de agua es del encolado, no del intento**: dice desde qué punto de la
 *     conversación se pidió, y es lo que permite distinguir un turno que no llegó a escribir
 *     —seguro de rehacer— de uno que ya escribió, que no lo es.
 */
import type { Database as Db } from 'better-sqlite3';
import { newJobId } from './ids.js';

export const JOB_STATUSES = ['ready', 'running', 'done', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

interface JobRow {
  id: string;
  kind: string;
  resource_type: string;
  resource_id: string;
  status: string;
  available_at: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  watermark_seq: number | null;
  created_at: string;
  updated_at: string;
}

export interface Job {
  id: string;
  kind: string;
  resourceType: string;
  resourceId: string;
  status: JobStatus;
  availableAt: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  /** El `seq` del último mensaje cuando se encoló. `null` si el trabajo no habla de un hilo. */
  watermarkSeq: number | null;
  createdAt: string;
  updatedAt: string;
}

const toJob = (row: JobRow): Job => ({
  id: row.id,
  kind: row.kind,
  resourceType: row.resource_type,
  resourceId: row.resource_id,
  status: row.status as JobStatus,
  availableAt: row.available_at,
  attempts: row.attempts,
  maxAttempts: row.max_attempts,
  lastError: row.last_error,
  watermarkSeq: row.watermark_seq,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * Cuánto se espera antes de volver a intentarlo: `2^intentos × 2 s`, con techo de cinco minutos.
 *
 * El techo existe porque sin él el quinto intento caería a media hora y una conversación que se
 * reanuda media hora después ya no le sirve a nadie: quien preguntó se fue.
 */
export const backoffMs = (attempts: number): number => Math.min(2 ** attempts * 2_000, 300_000);

export class JobRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * Apunta que alguien pidió algo. Si ya había uno vivo para ese recurso, devuelve **ése**.
   *
   * Devolver el que había en vez de fallar es lo que hace que el que llama no tenga que saber si
   * es el primero: pedir dos veces lo mismo mientras lo primero sigue pendiente no es un error,
   * es impaciencia, y la respuesta correcta es «ya está pedido».
   */
  enqueue(input: {
    kind: string;
    resourceType: string;
    resourceId: string;
    watermarkSeq?: number | null;
    at: string;
    maxAttempts?: number;
  }): Job {
    const existing = this.alive(input.resourceType, input.resourceId, input.kind);
    if (existing) return existing;

    const id = newJobId();
    this.#db.prepare(`
      INSERT INTO jobs (id, kind, resource_type, resource_id, status, available_at,
                        attempts, max_attempts, last_error, watermark_seq, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'ready', ?, 0, ?, NULL, ?, ?, ?)
    `).run(id, input.kind, input.resourceType, input.resourceId, input.at,
      input.maxAttempts ?? 5, input.watermarkSeq ?? null, input.at, input.at);
    return this.require(id);
  }

  /** El trabajo vivo de este recurso, si lo hay. Vivo es `ready` o `running`, como el índice. */
  alive(resourceType: string, resourceId: string, kind?: string): Job | null {
    const row = this.#db.prepare(`
      SELECT * FROM jobs
      WHERE resource_type = ? AND resource_id = ? AND status IN ('ready', 'running')
        AND (? IS NULL OR kind = ?)
      LIMIT 1
    `).get(resourceType, resourceId, kind ?? null, kind ?? null) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  /**
   * Coge el siguiente trabajo que toque y lo marca `running`, en una sola transacción.
   *
   * La transacción no es por concurrencia entre procesos —hay un solo consumidor— sino para que
   * un fallo entre leer y marcar no deje un trabajo cogido por nadie.
   */
  claim(kind: string, now: string): Job | null {
    const claim = this.#db.transaction((): Job | null => {
      const row = this.#db.prepare(`
        SELECT * FROM jobs
        WHERE kind = ? AND status = 'ready' AND available_at <= ?
        ORDER BY available_at, created_at
        LIMIT 1
      `).get(kind, now) as JobRow | undefined;
      if (!row) return null;
      this.#db.prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?")
        .run(now, row.id);
      return this.require(row.id);
    });
    return claim();
  }

  /** Salió bien. Se queda como historial de lo que pasó, no se borra. */
  finish(id: string, at: string): void {
    this.#db.prepare("UPDATE jobs SET status = 'done', last_error = NULL, updated_at = ? WHERE id = ?")
      .run(at, id);
  }

  /**
   * Salió mal. Vuelve a la cola con espera, o se rinde si ya gastó los intentos.
   *
   * `nextAt` lo calcula quien llama porque es quien tiene el reloj: aquí no se inventa el tiempo.
   */
  retry(id: string, error: string, at: string, nextAt: string): Job {
    const job = this.require(id);
    const agotado = job.attempts >= job.maxAttempts;
    this.#db.prepare(`
      UPDATE jobs SET status = ?, last_error = ?, available_at = ?, updated_at = ? WHERE id = ?
    `).run(agotado ? 'failed' : 'ready', error.slice(0, 500), nextAt, at, id);
    return this.require(id);
  }

  /** Se abandona sin más intentos: lo que no se debe rehacer no se reencola. */
  abandon(id: string, reason: string, at: string): void {
    this.#db.prepare("UPDATE jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?")
      .run(reason.slice(0, 500), at, id);
  }

  /**
   * Los que se quedaron en `running` sin nadie ejecutándolos.
   *
   * Sólo tiene sentido al arrancar: con un consumidor y en marcha, un `running` es uno que se está
   * haciendo ahora mismo. Por eso lo llama `reconcile()` y nadie más.
   */
  orphans(kind: string): Job[] {
    const rows = this.#db.prepare("SELECT * FROM jobs WHERE kind = ? AND status = 'running' ORDER BY created_at")
      .all(kind) as JobRow[];
    return rows.map(toJob);
  }

  /** Cuántos hay por estado. Para el salto de salud, que quiere una cifra y no una lista. */
  counts(): Record<JobStatus, number> {
    const rows = this.#db.prepare('SELECT status, COUNT(*) n FROM jobs GROUP BY status')
      .all() as Array<{ status: string; n: number }>;
    const counts = { ready: 0, running: 0, done: 0, failed: 0 };
    for (const row of rows) {
      if (row.status in counts) counts[row.status as JobStatus] = row.n;
    }
    return counts;
  }

  find(id: string): Job | null {
    const row = this.#db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  require(id: string): Job {
    const job = this.find(id);
    if (!job) throw new Error(`unknown job ${id}`);
    return job;
  }
}
