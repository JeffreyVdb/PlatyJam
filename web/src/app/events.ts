/**
 * A tiny typed event bus. `on` returns its own unsubscribe function.
 *
 * Handlers run synchronously in subscription order. A throwing handler is logged and
 * does not stop the others, so one broken module cannot take down the app shell.
 */
export interface EventBus<Events extends object> {
  on<K extends keyof Events>(type: K, handler: (payload: Events[K]) => void): () => void;
  emit<K extends keyof Events>(type: K, payload: Events[K]): void;
}

export function createEventBus<Events extends object>(): EventBus<Events> {
  const handlers = new Map<keyof Events, Set<(payload: never) => void>>();

  return {
    on(type, handler) {
      let set = handlers.get(type);
      if (!set) {
        set = new Set();
        handlers.set(type, set);
      }
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },

    emit(type, payload) {
      const set = handlers.get(type);
      if (!set) return;
      // Copy so handlers may unsubscribe (or subscribe) while we iterate.
      for (const handler of [...set] as ((payload: Events[typeof type]) => void)[]) {
        try {
          handler(payload);
        } catch (error) {
          console.error(`[platyjam] "${String(type)}" handler failed`, error);
        }
      }
    },
  };
}
