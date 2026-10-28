import { DestroyRef, inject, Service, signal } from '@angular/core';
import { SERVER_EVENT_TYPES, ServerEvent } from '@ledger-lens/contracts';
import { Subject } from 'rxjs';
import { SessionService } from '../session/session';

/**
 * One server-sent-event connection per tab (`GET /api/events`). Consumers subscribe to `stream`; the browser's
 * EventSource reconnects by itself after a dropped connection, and we start a fresh session if the server answers 401.
 */
@Service()
export class EventStream {
  private readonly session = inject(SessionService);
  private source: EventSource | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  readonly stream = new Subject<ServerEvent>();
  readonly connected = signal(false);

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.disconnect();
    });
  }

  connect(): void {
    if (this.source || typeof EventSource === 'undefined') return;
    const source = new EventSource('/api/events');
    this.source = source;
    source.onopen = () => {
      this.connected.set(true);
    };
    source.onerror = () => {
      this.connected.set(false);
      // EventSource retries dropped connections itself, but gives up on an error status such as 401.
      if (source.readyState === EventSource.CLOSED) {
        this.source = null;
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => {
          void this.session.bootstrap().then(() => {
            this.connect();
          });
        }, 3000);
      }
    };
    for (const type of SERVER_EVENT_TYPES) {
      source.addEventListener(type, (event) => {
        const parsed = ServerEvent.safeParse(JSON.parse((event as MessageEvent<string>).data));
        if (parsed.success) this.stream.next(parsed.data);
      });
    }
  }

  disconnect(): void {
    clearTimeout(this.retryTimer);
    this.source?.close();
    this.source = null;
    this.connected.set(false);
  }
}
