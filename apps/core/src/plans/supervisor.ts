/**
 * El despertador de planes.
 *
 * Un plan no vive en una llamada abierta: duerme en SQLite y alguien lo despierta cuando hay
 * motivo —el run que esperaba terminó, la persona aprobó, o simplemente ha pasado el intervalo—.
 * Eso es lo que permite que un objetivo de cuatro horas sobreviva a un reinicio del core.
 */
import type { UserIdentity } from '@jarvis/contracts';
import type { PlanService } from './service.js';

export interface PlanSupervisorDeps {
  plans: PlanService;
  intervalMs: number;
  onError?: (error: Error, planId: string) => void;
}

export class PlanSupervisor {
  readonly #deps: PlanSupervisorDeps;
  readonly #inFlight = new Set<string>();
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;

  constructor(deps: PlanSupervisorDeps) {
    this.#deps = deps;
  }

  start(): void {
    this.#stopped = false;
    this.#schedule();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      void this.tick().finally(() => this.#schedule());
    }, this.#deps.intervalMs);
    this.#timer.unref?.();
  }

  /**
   * Una vuelta: cada plan activo intenta avanzar.
   *
   * `advance` es seguro de llamar de más —cada estado sabe si le toca esperar—, así que este
   * bucle no necesita saber por qué se despertó.
   */
  async tick(): Promise<void> {
    for (const plan of this.#deps.plans.listActive()) {
      if (this.#inFlight.has(plan.id)) continue;
      this.#inFlight.add(plan.id);
      try {
        const user: UserIdentity = { userId: `plan:${plan.id}`, username: plan.createdBy };
        await this.#deps.plans.advance(plan.id, user);
      } catch (error) {
        this.#deps.onError?.(error as Error, plan.id);
      } finally {
        this.#inFlight.delete(plan.id);
      }
    }
  }
}
