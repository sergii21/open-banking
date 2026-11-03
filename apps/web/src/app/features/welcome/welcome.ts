import { Component, computed, inject, signal } from '@angular/core';
import { ApiError } from '../../core/api';
import { countdown } from '../../core/format';
import { Nav } from '../../core/nav';
import { Session } from '../../core/session';
import { Ticker } from '../../core/ticker';
import { Icon } from '../../shared/icon';

@Component({
  selector: 'll-welcome',
  imports: [Icon],
  templateUrl: './welcome.html',
})
export class Welcome {
  protected readonly session = inject(Session);
  private readonly nav = inject(Nav);
  private readonly ticker = inject(Ticker);

  protected readonly token = signal('');
  protected readonly shown = signal(false);
  protected readonly busy = signal<'token' | 'demo' | null>(null);
  protected readonly error = signal<string | null>(null);
  private readonly retryAt = signal<number | null>(null);
  protected readonly wait = computed(() => {
    const at = this.retryAt();
    return at === null ? 0 : Math.max(0, at - this.ticker.now());
  });
  protected readonly waitText = computed(() => countdown(this.wait()));

  protected async connect(): Promise<void> {
    if (!this.token().trim() || this.busy() || this.wait() > 0) return;
    this.busy.set('token');
    this.error.set(null);
    try {
      await this.session.connectToken(this.token());
      this.token.set('');
      await this.nav.go('/home', true);
    } catch (error) {
      this.explain(error);
    } finally {
      this.busy.set(null);
    }
  }

  protected async demo(): Promise<void> {
    if (this.busy()) return;
    this.busy.set('demo');
    this.error.set(null);
    try {
      await this.session.connectDemo();
      await this.nav.go('/home', true);
    } catch (error) {
      this.explain(error);
    } finally {
      this.busy.set(null);
    }
  }

  private explain(error: unknown): void {
    if (!(error instanceof ApiError)) {
      this.error.set('Something went wrong. Try again.');
      return;
    }
    if (error.offline) {
      this.error.set('Ledger Lens is not running. Start it again with ./start.sh and reload this page.');
    } else if (error.code === 'rate_limited') {
      this.retryAt.set(Date.now() + (error.retryAfterSeconds ?? 60) * 1000);
      this.error.set('monobank allows one check a minute, and one was just made.');
    } else if (error.code === 'bank_unavailable') {
      this.error.set('monobank is not responding right now. Try again in a minute.');
    } else {
      this.error.set(error.fields[0]?.message ?? error.message);
    }
  }
}
