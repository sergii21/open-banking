import { computed, effect, inject, Service, signal } from '@angular/core';
import type { InspectorCall, ServerEvent, SyncState } from '@ledger-lens/contracts';
import { Api } from './api';
import { Session } from './session';

/**
 * The server-sent event stream: the sync chip's state, "something changed, look again" (the version), and the calls the
 * Live API drawer shows. The browser's EventSource reconnects by itself after a dropped connection.
 */
@Service()
export class Live {
  private readonly api = inject(Api);
  private readonly session = inject(Session);

  readonly sync = signal<SyncState | null>(null);
  readonly calls = signal<InspectorCall[]>([]);
  readonly version = computed(() => this.sync()?.version ?? 0);
  private source: EventSource | null = null;

  constructor() {
    effect(() => {
      if (this.session.connected()) this.start();
      else this.stop();
    });
  }

  private start(): void {
    if (this.source || typeof EventSource === 'undefined') return;
    void this.api.get<SyncState>('/api/sync').then(
      (state) => this.sync.set(state),
      () => undefined,
    );
    void this.loadCalls();
    const source = new EventSource('/api/events');
    this.source = source;
    const on = (type: ServerEvent['type'], handler: (event: ServerEvent) => void): void => {
      source.addEventListener(type, (message) => {
        try {
          handler(JSON.parse((message as MessageEvent<string>).data) as ServerEvent);
        } catch {
          // A malformed event is ignored; the next one carries the full state anyway.
        }
      });
    };
    on('sync.updated', (event) => {
      if (event.type === 'sync.updated') this.sync.set(event.sync);
    });
    on('connection.updated', (event) => {
      if (event.type !== 'connection.updated') return;
      this.session.setConnection(event.connection);
    });
    on('inspector.call', (event) => {
      if (event.type === 'inspector.call')
        this.calls.update((list) => [event.call, ...list].slice(0, 200));
    });
  }

  private stop(): void {
    this.source?.close();
    this.source = null;
    this.sync.set(null);
    this.calls.set([]);
  }

  async loadCalls(): Promise<void> {
    try {
      this.calls.set(
        (await this.api.get<{ items: InspectorCall[] }>('/api/inspector/calls')).items,
      );
    } catch {
      // The drawer shows what it has.
    }
  }

  async clearCalls(): Promise<void> {
    await this.api.delete('/api/inspector/calls');
    this.calls.set([]);
  }
}
