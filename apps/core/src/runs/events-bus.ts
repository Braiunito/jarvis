/**
 * Un bus en memoria para despertar a los listeners SSE.
 *
 * No es el event log: sólo dice «hay novedades en este run». Quien escucha vuelve a leer de
 * SQLite desde su último `seq`, que es lo que hace que perder una notificación no pierda un
 * evento, y que reconectar no dependa de que este proceso recuerde nada.
 */
type Listener = (runId: string) => void;

export class RunEventBus {
  readonly #listeners = new Map<string, Set<Listener>>();

  notify(runId: string): void {
    for (const listener of this.#listeners.get(runId) ?? []) {
      try {
        listener(runId);
      } catch {
        // Un listener roto no puede parar la ingesta de los demás.
      }
    }
    for (const listener of this.#listeners.get('*') ?? []) {
      try {
        listener(runId);
      } catch {
        // ídem
      }
    }
  }

  subscribe(runId: string, listener: Listener): () => void {
    let set = this.#listeners.get(runId);
    if (!set) {
      set = new Set();
      this.#listeners.set(runId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) this.#listeners.delete(runId);
    };
  }

  get size(): number {
    let total = 0;
    for (const set of this.#listeners.values()) total += set.size;
    return total;
  }
}
