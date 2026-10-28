import { Component, computed, inject } from '@angular/core';
import { MatButton } from '@angular/material/button';
import { RouterLink } from '@angular/router';
import { describeError } from '../../core/api/api-error';
import { Data } from '../../core/data/data';
import { Money } from '../../shared/money/money';
import { Skeleton } from '../../shared/states/skeleton';
import { StateCard } from '../../shared/states/state-card';
import { TransactionRow } from '../../shared/transaction-row/transaction-row';
import { AccountCard } from './account-card';
import { ConsentBanner } from './consent-banner';

@Component({
  selector: 'll-dashboard',
  imports: [
    AccountCard,
    ConsentBanner,
    MatButton,
    Money,
    RouterLink,
    Skeleton,
    StateCard,
    TransactionRow,
  ],
  templateUrl: './dashboard.html',
})
export class Dashboard {
  protected readonly data = inject(Data);

  protected readonly loading = computed(
    () => this.data.connections.status() === 'loading' || this.data.accounts.status() === 'loading',
  );
  protected readonly failed = computed(
    () => this.data.connections.status() === 'error' || this.data.accounts.status() === 'error',
  );
  protected readonly failure = computed(() =>
    describeError(this.data.connections.error() ?? this.data.accounts.error()),
  );

  protected readonly connectionsById = computed(
    () => new Map(this.data.connections.value().map((c) => [c.id, c])),
  );
  protected readonly accountNames = computed(
    () => new Map(this.data.accounts.value().map((a) => [a.id, a.name])),
  );
  protected readonly attention = computed(() =>
    this.data.connections
      .value()
      .filter((c) => c.status !== 'active' || c.consentState === 'expiring_soon'),
  );

  /** Net balance per currency. Amounts in different currencies are never added together. */
  protected readonly totals = computed(() => {
    const byCurrency = new Map<string, { amountMinor: number; accounts: number }>();
    for (const account of this.data.accounts.value()) {
      const entry = byCurrency.get(account.currency) ?? { amountMinor: 0, accounts: 0 };
      entry.amountMinor += account.balance.amountMinor;
      entry.accounts += 1;
      byCurrency.set(account.currency, entry);
    }
    return [...byCurrency]
      .map(([currency, value]) => ({ currency, ...value }))
      .sort((a, b) => a.currency.localeCompare(b.currency));
  });

  protected readonly recent = computed(() => this.data.recentTransactions.value()?.items ?? []);
}
