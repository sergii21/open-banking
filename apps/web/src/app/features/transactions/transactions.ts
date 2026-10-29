import { HttpClient, httpResource } from '@angular/common/http';
import { Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { MatButton } from '@angular/material/button';
import { MatButtonToggle, MatButtonToggleGroup } from '@angular/material/button-toggle';
import { MatFormField, MatLabel, MatPrefix } from '@angular/material/form-field';
import { MatIcon } from '@angular/material/icon';
import { MatInput } from '@angular/material/input';
import { MatOption, MatSelect } from '@angular/material/select';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltip } from '@angular/material/tooltip';
import {
  CATEGORIES,
  Transaction as TransactionSchema,
  TransactionPage,
  type Category,
  type Transaction,
} from '@ledger-lens/contracts';
import { firstValueFrom } from 'rxjs';
import { describeError, toApiError, type ErrorCopy } from '../../core/api/api-error';
import { Ticker } from '../../core/clock/ticker';
import { Data } from '../../core/data/data';
import { CATEGORY_INFO } from '../../shared/categories';
import { dayHeading } from '../../shared/format';
import { Skeleton } from '../../shared/states/skeleton';
import { StateCard } from '../../shared/states/state-card';
import { SyncBanner } from '../../shared/sync-banner/sync-banner';
import { TransactionRow } from '../../shared/transaction-row/transaction-row';
import { TransactionFilters } from './transaction-filters';

interface DayGroup {
  day: string;
  heading: string;
  items: Transaction[];
}

@Component({
  selector: 'll-transactions',
  imports: [
    MatButton,
    MatButtonToggle,
    MatButtonToggleGroup,
    MatFormField,
    MatIcon,
    MatInput,
    MatLabel,
    MatOption,
    MatPrefix,
    MatSelect,
    MatTooltip,
    Skeleton,
    StateCard,
    SyncBanner,
    TransactionRow,
  ],
  templateUrl: './transactions.html',
})
export class Transactions {
  protected readonly filters = inject(TransactionFilters);
  protected readonly data = inject(Data);
  private readonly http = inject(HttpClient);
  private readonly ticker = inject(Ticker);
  private readonly snackBar = inject(MatSnackBar);

  protected readonly categories: readonly Category[] = CATEGORIES;
  protected readonly categoryInfo = CATEGORY_INFO;
  protected readonly advancedOpen = signal(false);

  protected readonly firstPage = httpResource<TransactionPage | undefined>(
    () => ({ url: '/api/transactions', params: this.filters.params() }),
    { parse: (raw) => TransactionPage.parse(raw) },
  );

  /** The loaded rows: the first page, then whatever "Load more" appended. Resets whenever the filters change. */
  protected readonly items = linkedSignal<TransactionPage | undefined, Transaction[]>({
    source: () => this.firstPage.value(),
    computation: (page) => page?.items ?? [],
  });
  protected readonly cursor = linkedSignal<TransactionPage | undefined, string | null>({
    source: () => this.firstPage.value(),
    computation: (page) => page?.nextCursor ?? null,
  });
  protected readonly total = computed(() => this.firstPage.value()?.total ?? 0);

  protected readonly loadingMore = signal(false);
  protected readonly moreFailure = signal<ErrorCopy | null>(null);

  protected readonly loading = computed(() => this.firstPage.status() === 'loading');
  protected readonly failure = computed(() => describeError(this.firstPage.error()));
  protected readonly accountNames = computed(
    () => new Map(this.data.accounts.value().map((a) => [a.id, a.name])),
  );

  protected readonly groups = computed<DayGroup[]>(() => {
    const byDay = new Map<string, Transaction[]>();
    for (const transaction of this.items()) {
      const day = transaction.bookedAt.slice(0, 10);
      byDay.set(day, [...(byDay.get(day) ?? []), transaction]);
    }
    const now = this.ticker.now();
    return [...byDay].map(([day, items]) => ({ day, heading: dayHeading(day, now), items }));
  });

  /** The same filters as the list, without paging: the download is everything they match. */
  protected readonly exportUrl = computed(() => {
    const { limit: _limit, cursor: _cursor, ...rest } = this.filters.params();
    return `/api/transactions/export.csv?${new URLSearchParams(rest).toString()}`;
  });

  /** The customer's own category for one transaction. It is kept when the bank sends the transaction again. */
  protected async changeCategory(transaction: Transaction, category: Category): Promise<void> {
    if (category === transaction.category && transaction.categorySource === 'user') return;
    try {
      const updated = TransactionSchema.parse(
        await firstValueFrom(this.http.patch(`/api/transactions/${transaction.id}`, { category })),
      );
      const leavesFilter = this.filters.category() !== null && this.filters.category() !== category;
      this.items.update((items) =>
        leavesFilter
          ? items.filter((item) => item.id !== updated.id)
          : items.map((item) => (item.id === updated.id ? updated : item)),
      );
      this.data.recentTransactions.reload();
      this.snackBar.open(`Filed under ${CATEGORY_INFO[category].label}`, 'OK');
    } catch (error) {
      this.snackBar.open(toApiError(error).message, 'OK');
    }
  }

  protected valueOf(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected async loadMore(): Promise<void> {
    const cursor = this.cursor();
    const base = this.firstPage.value();
    if (!cursor || this.loadingMore()) return;
    this.loadingMore.set(true);
    this.moreFailure.set(null);
    try {
      const page = TransactionPage.parse(
        await firstValueFrom(
          this.http.get('/api/transactions', { params: { ...this.filters.params(), cursor } }),
        ),
      );
      // The filters may have changed while this was in flight; then these rows no longer belong on screen.
      if (this.firstPage.value() !== base) return;
      this.items.update((items) => [...items, ...page.items]);
      this.cursor.set(page.nextCursor);
    } catch (error) {
      this.moreFailure.set(describeError(error));
    } finally {
      this.loadingMore.set(false);
    }
  }
}
