import { effect, inject, Service, signal, untracked } from '@angular/core';
import type { Activity, Home, Insights } from '@ledger-lens/contracts';
import { Api } from './api';
import { Live } from './live';
import { Remote } from './remote';
import { Session } from './session';

/** Server data for the three tabs, kept in memory and quietly refreshed whenever the server says something changed. */
@Service()
export class Stores {
  private readonly api = inject(Api);
  private readonly live = inject(Live);
  private readonly session = inject(Session);

  readonly home = new Remote<Home>((s) => this.api.get('/api/home', s));
  readonly activity = new Remote<Activity>((s) => this.api.get('/api/activity', s));
  readonly insightsMonth = signal<string | null>(null);
  readonly insights = new Remote<Insights>((s) => {
    const month = this.insightsMonth();
    return this.api.get(`/api/insights${month ? `?month=${month}` : ''}`, s);
  });

  private lastVersion = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    effect(() => {
      const version = this.live.version();
      untracked(() => {
        if (version === 0 || version === this.lastVersion) return;
        this.lastVersion = version;
        // Several steps can finish in a burst (the demo loads everything at once): look again once they settle.
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.refreshLoaded(), 250);
      });
    });
    effect(() => {
      if (!this.session.connected()) untracked(() => this.resetAll());
    });
  }

  refreshLoaded(): void {
    for (const remote of [this.home, this.activity, this.insights]) {
      if (remote.data() !== null) void remote.reload();
    }
  }

  resetAll(): void {
    this.home.reset();
    this.activity.reset();
    this.insights.reset();
    this.insightsMonth.set(null);
    this.lastVersion = 0;
  }
}
