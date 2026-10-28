import { HttpClient } from '@angular/common/http';
import { computed, inject, Service, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { InspectorCallList, type InspectorCall } from '@ledger-lens/contracts';
import { filter, firstValueFrom } from 'rxjs';
import { EventStream } from '../events/events';

interface Entry {
  call: InspectorCall;
  /** When this tab first saw the call (epoch ms); 0 for history loaded on startup. */
  seenAt: number;
}

const MAX_ENTRIES = 200;

/**
 * Client side of the API Inspector: the provider calls the BFF made for this session, newest first. "This screen"
 * means calls that arrived since you navigated here. Reading a screen from cache makes no provider calls, and the
 * panel says so, which is part of the lesson.
 */
@Service()
export class InspectorStore {
  private readonly http = inject(HttpClient);

  readonly open = signal(false);
  readonly scope = signal<'screen' | 'all'>('screen');
  private readonly entries = signal<Entry[]>([]);
  private readonly screenStartedAt = signal(Date.now());
  /** Calls that arrived while the panel was closed. */
  readonly unseen = signal(0);

  readonly all = computed(() => this.entries().map((entry) => entry.call));
  readonly visible = computed(() => {
    const since = this.screenStartedAt();
    const entries = this.entries();
    return (
      this.scope() === 'all' ? entries : entries.filter((entry) => entry.seenAt >= since)
    ).map((entry) => entry.call);
  });

  constructor() {
    inject(EventStream)
      .stream.pipe(takeUntilDestroyed())
      .subscribe((event) => {
        if (event.type !== 'inspector.call') return;
        this.entries.update((list) =>
          list.some((entry) => entry.call.id === event.call.id)
            ? list
            : [{ call: event.call, seenAt: Date.now() }, ...list].slice(0, MAX_ENTRIES),
        );
        if (!this.open()) this.unseen.update((n) => n + 1);
      });

    inject(Router)
      .events.pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => {
        this.screenStartedAt.set(Date.now());
      });
  }

  async load(): Promise<void> {
    const list = InspectorCallList.parse(
      await firstValueFrom(this.http.get('/api/inspector/calls')),
    );
    this.entries.update((current) => {
      const known = new Set(current.map((entry) => entry.call.id));
      return [
        ...current,
        ...list.items.filter((call) => !known.has(call.id)).map((call) => ({ call, seenAt: 0 })),
      ]
        .sort((a, b) => b.call.at.localeCompare(a.call.at))
        .slice(0, MAX_ENTRIES);
    });
  }

  toggle(): void {
    this.open.update((open) => !open);
  }

  markSeen(): void {
    this.unseen.set(0);
  }

  async clear(): Promise<void> {
    await firstValueFrom(this.http.delete('/api/inspector/calls'));
    this.entries.set([]);
  }
}
