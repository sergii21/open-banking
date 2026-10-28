import type { ServerEvent } from '@ledger-lens/contracts';

type Listener = (event: ServerEvent) => void;

/** In-process fan-out of server events to the SSE connections of one session. */
export class EventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  subscribe(sessionId: string, listener: Listener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(sessionId);
    };
  }

  publish(sessionId: string, event: ServerEvent): void {
    for (const listener of this.listeners.get(sessionId) ?? []) {
      try {
        listener(event);
      } catch {
        // A broken subscriber (closed socket) must never affect the publisher or other subscribers.
      }
    }
  }

  subscriberCount(sessionId: string): number {
    return this.listeners.get(sessionId)?.size ?? 0;
  }
}
