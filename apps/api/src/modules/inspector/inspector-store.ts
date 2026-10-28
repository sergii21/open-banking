import type { InspectorCall } from '@ledger-lens/contracts';
import type { EventBus } from '../events/event-bus';

/**
 * In-memory ring buffer of recent provider calls, one per session. Not persisted: it exists to show a reader what
 * the BFF just did, and restarting the server clears it. Calls arrive already redacted.
 */
export class InspectorStore {
  private readonly buffers = new Map<string, InspectorCall[]>();

  constructor(
    private readonly events: EventBus,
    private readonly perSession = 200,
    private readonly maxSessions = 500,
  ) {}

  record(sessionId: string, call: InspectorCall): void {
    const existing = this.buffers.get(sessionId) ?? [];
    this.buffers.delete(sessionId); // re-insert to keep Map order = least recently used first
    existing.push(call);
    if (existing.length > this.perSession) existing.splice(0, existing.length - this.perSession);
    this.buffers.set(sessionId, existing);

    if (this.buffers.size > this.maxSessions) {
      const oldest = this.buffers.keys().next().value;
      if (oldest !== undefined) this.buffers.delete(oldest);
    }
    this.events.publish(sessionId, { type: 'inspector.call', call });
  }

  /** Newest first. */
  list(sessionId: string): InspectorCall[] {
    return [...(this.buffers.get(sessionId) ?? [])].reverse();
  }

  clear(sessionId: string): void {
    this.buffers.delete(sessionId);
  }
}
