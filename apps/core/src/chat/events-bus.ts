/**
 * Despertador de los listeners SSE de una conversación.
 *
 * Igual que el de los runs y por el mismo motivo: no es el registro, sólo dice «hay algo nuevo
 * aquí». Quien escucha vuelve a leer de SQLite desde su último `seq`, así que perder una
 * notificación no pierde un mensaje y reconectar no depende de que este proceso recuerde nada.
 */
type Listener = (conversationId: string) => void;

export class ChatEventBus {
  readonly #listeners = new Map<string, Set<Listener>>();

  notify(conversationId: string): void {
    for (const listener of this.#listeners.get(conversationId) ?? []) {
      try {
        listener(conversationId);
      } catch {
        // Un listener roto no puede parar al resto ni al turno que está escribiendo.
      }
    }
  }

  subscribe(conversationId: string, listener: Listener): () => void {
    let set = this.#listeners.get(conversationId);
    if (!set) {
      set = new Set();
      this.#listeners.set(conversationId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) this.#listeners.delete(conversationId);
    };
  }

  get size(): number {
    let total = 0;
    for (const set of this.#listeners.values()) total += set.size;
    return total;
  }
}
