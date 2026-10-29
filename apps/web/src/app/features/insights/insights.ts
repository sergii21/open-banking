import { httpResource } from '@angular/common/http';
import { Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButton } from '@angular/material/button';
import { RouterLink } from '@angular/router';
import { InsightsSummary } from '@ledger-lens/contracts';
import { describeError } from '../../core/api/api-error';
import { Ticker } from '../../core/clock/ticker';
import { Data } from '../../core/data/data';
import { EventStream } from '../../core/events/events';
import { formatDate } from '../../shared/format';
import { Segmented } from '../../shared/segmented/segmented';
import { Skeleton } from '../../shared/states/skeleton';
import { StateCard } from '../../shared/states/state-card';
import { StatTile } from '../../shared/stat-tile/stat-tile';
import { SyncBanner } from '../../shared/sync-banner/sync-banner';
import { CategoryBars } from './category-bars';
import { PERIODS, periodStart, type Period } from './insights-view';
import { MonthlyChart } from './monthly-chart';
import { RecurringList } from './recurring-list';

/**
 * Where the money goes: totals, spending by category, income against spending by month, and the standing payments, all
 * worked out by the BFF from the transactions it has cached (nothing here calls a bank). One period filter above everything
 * scopes every figure on the page, so the numbers always agree.
 */
@Component({
  selector: 'll-insights',
  imports: [
    CategoryBars,
    MatButton,
    MonthlyChart,
    RecurringList,
    RouterLink,
    Segmented,
    Skeleton,
    StateCard,
    StatTile,
    SyncBanner,
  ],
  templateUrl: './insights.html',
})
export class Insights {
  protected readonly data = inject(Data);
  private readonly ticker = inject(Ticker);

  protected readonly periods = PERIODS;
  protected readonly period = signal<Period>('6');
  private readonly from = computed(() =>
    periodStart(new Date(this.ticker.now()), Number(this.period())),
  );

  protected readonly resource = httpResource<InsightsSummary>(
    () => ({ url: '/api/insights/summary', params: { from: this.from() } }),
    { parse: (raw) => InsightsSummary.parse(raw) },
  );

  /** What is on screen: the latest answer, and while the next one loads, the previous one (no skeleton flash, no jump). */
  protected readonly summary = linkedSignal<
    InsightsSummary | undefined,
    InsightsSummary | undefined
  >({
    source: () => (this.resource.hasValue() ? this.resource.value() : undefined),
    computation: (next, previous) => next ?? previous?.value,
  });
  protected readonly refreshing = computed(
    () => this.resource.isLoading() && this.summary() !== undefined,
  );
  protected readonly firstLoad = computed(
    () => this.resource.isLoading() && this.summary() === undefined,
  );
  protected readonly failure = computed(() => describeError(this.resource.error()));
  protected readonly range = computed(() => {
    const summary = this.summary();
    return summary ? `${formatDate(summary.from)} to ${formatDate(summary.to)}` : '';
  });

  constructor() {
    // History can still be arriving (a paced bank), and a refresh changes the numbers: pick the new ones up.
    inject(EventStream)
      .stream.pipe(takeUntilDestroyed())
      .subscribe((event) => {
        if (event.type === 'connection.updated') this.resource.reload();
      });
  }

  protected recurringFor(currency: string) {
    return (this.summary()?.recurring ?? []).filter(
      (payment) => payment.amount.currency === currency,
    );
  }
}
