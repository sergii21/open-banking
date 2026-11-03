import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { formatMoney, type Account } from '@ledger-lens/contracts';
import { timeZone } from '../../core/format';
import { Live } from '../../core/live';
import { Nav } from '../../core/nav';
import { Session } from '../../core/session';
import { Stores } from '../../core/stores';
import { Ui } from '../../core/ui';
import { CATEGORY_LABEL } from '../../shared/categories';
import { DailyBars, Sparkline } from '../../shared/charts';
import { Amount } from '../../shared/amount';
import { categoryIcon, Icon } from '../../shared/icon';
import { monthLabel } from '../../core/format';

const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

@Component({
  selector: 'll-home',
  imports: [Amount, Icon, Sparkline, DailyBars],
  templateUrl: './home.html',
})
export class Home {
  protected readonly stores = inject(Stores);
  protected readonly session = inject(Session);
  protected readonly live = inject(Live);
  protected readonly ui = inject(Ui);
  protected readonly nav = inject(Nav);

  protected readonly home = this.stores.home.data;
  protected readonly categoryIcon = categoryIcon;
  protected readonly labelOf = CATEGORY_LABEL;
  protected readonly skeletonTiles = [1, 2, 3, 4];

  /** The big number counts up to its value the first time and eases between values after that. */
  protected readonly shown = signal(0);

  protected readonly trend = computed(() => {
    const trend = this.home()?.trend;
    if (!trend || trend.points.length < 2) return null;
    const first = trend.points[0] ?? 0;
    const last = trend.points.at(-1) ?? 0;
    return { ...trend, change: last - first };
  });

  protected readonly foreign = computed(() => {
    const totals = new Map<string, number>();
    for (const account of this.home()?.accounts ?? []) {
      if (account.currency !== 'UAH') {
        totals.set(account.currency, (totals.get(account.currency) ?? 0) + account.ownMinor);
      }
    }
    return [...totals].map(([currency, minor]) => ({
      currency,
      text: formatMoney(minor, currency, { fraction: false }),
    }));
  });

  protected readonly credit = computed(() => {
    const home = this.home();
    if (!home) return null;
    const hasLimit = home.accounts.some((a) => a.creditLimitMinor > 0);
    return hasLimit && home.hero.availableUahMinor !== home.hero.ownUahMinor
      ? home.hero.availableUahMinor
      : null;
  });

  protected readonly ratesNote = computed(() => {
    const home = this.home();
    if (!home) return '';
    const parts: string[] = [];
    if (home.rates.asOf) {
      const at = new Intl.DateTimeFormat('en-GB', {
        timeZone: timeZone(),
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(Date.parse(home.rates.asOf));
      parts.push(`monobank rates from ${at}${home.rates.stale ? ' (could not refresh)' : ''}`);
    } else if (this.foreign().length > 0) {
      parts.push('rates loading');
    }
    if (home.hero.unconverted > 0) {
      parts.push(
        `${home.hero.unconverted} account${home.hero.unconverted === 1 ? '' : 's'} left out (no rate)`,
      );
    }
    return parts.join(' · ');
  });

  protected readonly monthTitle = computed(() => monthLabel(this.home()?.month.label ?? '2000-01'));
  protected readonly delta = computed(() => {
    const month = this.home()?.month;
    if (!month) return null;
    if (month.previousSameDaysMinor === null) return { kind: 'loading' as const };
    if (month.previousSameDaysMinor === 0) return { kind: 'none' as const };
    const pct = Math.round(
      ((month.spentMinor - month.previousSameDaysMinor) / month.previousSameDaysMinor) * 100,
    );
    return {
      kind: 'pct' as const,
      pct,
      text: `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct)}%`,
      tone: pct <= 0 ? 'good' : 'plain',
    };
  });

  protected readonly topMax = computed(() =>
    Math.max(1, ...(this.home()?.topCategories ?? []).map((c) => c.spentMinor)),
  );

  constructor() {
    this.stores.home.ensure();
    effect(() => {
      const target = this.home()?.hero.ownUahMinor;
      if (target !== undefined) untracked(() => this.countTo(target));
    });
  }

  private countTo(target: number): void {
    const from = this.shown();
    if (from === target) return;
    if (reducedMotion()) {
      this.shown.set(target);
      return;
    }
    const started = performance.now();
    const duration = from === 0 ? 850 : 450;
    const step = (now: number): void => {
      const t = Math.min(1, (now - started) / duration);
      this.shown.set(Math.round(from + (target - from) * (1 - (1 - t) ** 3)));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  protected tileNote(account: Account): string {
    if (account.history.state !== 'done') return 'Loading history…';
    if (account.creditLimitMinor > 0) {
      return `With credit ${formatMoney(account.availableMinor, account.currency, { fraction: false })}`;
    }
    if (account.kind === 'jar' && account.goalMinor) {
      return `${Math.min(100, Math.round((account.ownMinor / account.goalMinor) * 100))}% of ${formatMoney(account.goalMinor, account.currency, { fraction: false })}`;
    }
    if (account.currency !== 'UAH' && account.ownUahMinor !== null) {
      return `≈ ${formatMoney(account.ownUahMinor, 'UAH', { fraction: false })}`;
    }
    return '';
  }

  protected goalWidth(account: Account): string | null {
    return account.kind === 'jar' && account.goalMinor
      ? `${Math.min(100, Math.max(0, (account.ownMinor / account.goalMinor) * 100))}%`
      : null;
  }
}
