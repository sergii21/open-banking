import { Component, computed, inject, signal } from '@angular/core';
import { NgComponentOutlet } from '@angular/common';
import { countdown, ago } from './core/format';
import { Live } from './core/live';
import { Prefs } from './core/prefs';
import { Session } from './core/session';
import { SyncActions } from './core/sync';
import { Ticker } from './core/ticker';
import { Toast } from './core/toast';
import { Ui } from './core/ui';
import { Nav } from './core/nav';
import { Icon } from './shared/icon';
import { LiveApi } from './features/settings/live-api';
import { WiseDraft } from './features/wise/draft';
import { Settings } from './features/settings/settings';

@Component({
  selector: 'll-root',
  imports: [NgComponentOutlet, Icon, Settings, LiveApi, WiseDraft],
  templateUrl: './app.html',
  host: {
    '(window:scroll)': 'onScroll()',
    '(window:keydown)': 'onKey($event)',
    '(window:touchstart)': 'pullStart($event)',
    '(window:touchmove)': 'pullMove($event)',
    '(window:touchend)': 'pullEnd()',
  },
})
export class App {
  protected readonly session = inject(Session);
  protected readonly live = inject(Live);
  protected readonly prefs = inject(Prefs);
  protected readonly ui = inject(Ui);
  protected readonly toast = inject(Toast);
  private readonly ticker = inject(Ticker);
  private readonly sync = inject(SyncActions);
  protected readonly nav = inject(Nav);

  protected readonly scrolled = signal(false);
  protected readonly pull = signal(0);

  /** The sync chip: what the loader is doing, in words, and when it will do the next thing. */
  protected readonly chip = computed(() => {
    const state = this.live.sync();
    const now = this.ticker.now();
    if (!state) return { state: 'idle', long: 'Connecting…', short: '…' };
    const progress = state.total > 0 ? `${state.done} of ${state.total}` : '';
    if (state.phase === 'attention') {
      return state.needsToken
        ? { state: 'attention', long: 'New token needed', short: 'New token' }
        : { state: 'attention', long: 'Needs attention', short: 'Attention' };
    }
    if (state.phase === 'loading') {
      return {
        state: 'loading',
        long: progress ? `Loading history · ${progress}` : 'Loading…',
        short: progress ? `Loading ${progress}` : 'Loading',
      };
    }
    if (state.phase === 'waiting' && state.nextAt) {
      const wait = countdown(Date.parse(state.nextAt) - now);
      return {
        state: 'waiting',
        long: progress ? `Next step in ${wait} · ${progress}` : `Next step in ${wait}`,
        short: progress ? `${wait} · ${progress}` : wait,
      };
    }
    const when = state.updatedAt ? ago(Date.parse(state.updatedAt), now) : 'just now';
    return { state: 'idle', long: `Updated ${when}`, short: when };
  });

  private chord: ReturnType<typeof setTimeout> | undefined;
  private awaitingChord = false;
  private pullFrom: number | null = null;

  protected refresh(): void {
    if (this.live.sync()?.needsToken) this.ui.settings.set(true);
    else void this.sync.refresh();
  }

  protected onScroll(): void {
    const scrolled = window.scrollY > 4;
    if (scrolled !== this.scrolled()) this.scrolled.set(scrolled);
  }

  protected onKey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (target?.closest('input, textarea, select, [contenteditable], dialog')) return;
    if (!this.session.connected()) return;
    if (this.awaitingChord) {
      this.awaitingChord = false;
      clearTimeout(this.chord);
      const to = { h: '/home', a: '/activity', i: '/insights' }[event.key.toLowerCase()];
      if (to) {
        event.preventDefault();
        void this.nav.go(to);
      }
      return;
    }
    if (event.key === 'g') {
      this.awaitingChord = true;
      this.chord = setTimeout(() => (this.awaitingChord = false), 1000);
    } else if (event.key === '/') {
      event.preventDefault();
      void this.nav.go('/activity').then(() => this.ui.focusSearch.update((n) => n + 1));
    }
  }

  protected pullStart(event: TouchEvent): void {
    this.pullFrom =
      window.scrollY <= 0 && event.touches.length === 1
        ? (event.touches[0]?.clientY ?? null)
        : null;
  }
  protected pullMove(event: TouchEvent): void {
    if (this.pullFrom === null) return;
    const dy = (event.touches[0]?.clientY ?? 0) - this.pullFrom;
    this.pull.set(dy > 0 ? Math.min(dy, 160) : 0);
  }
  protected pullEnd(): void {
    if (this.pullFrom !== null && this.pull() > 110) this.refresh();
    this.pullFrom = null;
    this.pull.set(0);
  }
}
