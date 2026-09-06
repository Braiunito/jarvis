/**
 * El único consumidor de la cola.
 *
 * Es un bucle de sondeo y no un sistema de eventos, por la misma razón que el resto de
 * supervisores de la casa: con un proceso y una base local, mirar cada pocos segundos cuesta una
 * consulta a un índice y no hay nada que coordinar. La cola no está para repartir trabajo entre
 * varios —`leases` sigue vacía a propósito— sino para que un turno pedido no se pierda en un
 * reinicio.
 *
 * Lo que **no** hace, y es lo que lo hace seguro: no decide si un trabajo se puede rehacer. Esa
 * decisión la tomó `reconcile()` al arrancar, comparando la marca de agua con lo que hay escrito
 * en el hilo. Aquí sólo se ejecuta lo que ya está declarado seguro; comprobarlo otra vez sería
 * tener la misma regla en dos sitios, que es como acaban diciendo cosas distintas.
 */
import type { Clock } from './clock.js';
import { backoffMs, type Job, type JobRepository } from './jobs.js';

export interface JobSupervisorDeps {
  jobs: JobRepository;
  clock: Clock;
  /** Qué hacer con cada trabajo, por tipo. Lo que no esté aquí se abandona diciéndolo. */
  handlers: Record<string, (job: Job) => Promise<void>>;
  intervalMs?: number;
  /** Para las pruebas: sin esto habría que esperar al reloj de verdad. */
  onError?: (error: Error, job: Job) => void;
}

export class JobSupervisor {
  readonly #deps: JobSupervisorDeps;
  readonly #intervalMs: number;
  #timer: NodeJS.Timeout | null = null;
  #running = false;

  constructor(deps: JobSupervisorDeps) {
    this.#deps = deps;
    this.#intervalMs = deps.intervalMs ?? 2_000;
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => void this.tick(), this.#intervalMs);
    // Que no sea el temporizador lo que mantiene vivo el proceso: si no queda nada más que hacer,
    // que el core pueda cerrarse.
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /**
   * Una vuelta: coge lo que toque de cada tipo y lo ejecuta.
   *
   * Es público para que las pruebas no dependan del reloj, y **reentrante-seguro**: si una vuelta
   * tarda más que el intervalo, la siguiente se salta en vez de solaparse. Dos vueltas a la vez
   * sobre el mismo trabajo es justo lo que la cola existe para evitar.
   */
  async tick(): Promise<number> {
    if (this.#running) return 0;
    this.#running = true;
    let hechos = 0;
    try {
      for (const [kind, handler] of Object.entries(this.#deps.handlers)) {
        const job = this.#deps.jobs.claim(kind, this.#deps.clock.nowIso());
        if (!job) continue;
        hechos += 1;
        await this.#run(job, handler);
      }
    } finally {
      this.#running = false;
    }
    return hechos;
  }

  async #run(job: Job, handler: (job: Job) => Promise<void>): Promise<void> {
    try {
      await handler(job);
      this.#deps.jobs.finish(job.id, this.#deps.clock.nowIso());
    } catch (error) {
      const at = this.#deps.clock.nowIso();
      const nextAt = new Date(this.#deps.clock.nowMs() + backoffMs(job.attempts)).toISOString();
      this.#deps.jobs.retry(job.id, (error as Error).message, at, nextAt);
      this.#deps.onError?.(error as Error, job);
    }
  }
}
