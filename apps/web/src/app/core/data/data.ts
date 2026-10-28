import { HttpClient, httpResource } from '@angular/common/http';
import { inject, Service, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  AccountList,
  ConnectionList,
  RefreshAccountResponse,
  TransactionPage,
  type Account,
  type Connection,
} from '@ledger-lens/contracts';
import { firstValueFrom } from 'rxjs';
import { EventStream } from '../events/events';

/**
 * Server state shared by every screen: connections, the cached accounts and the latest transactions. The BFF serves these
 * from its cache, so reloading is cheap; a `connection.updated` event (refresh finished, consent expiring, reconnect)
 * reloads them all.
 */
@Service()
export class Data {
  private readonly http = inject(HttpClient);

  readonly connections = httpResource<Connection[]>(() => '/api/connections', {
    defaultValue: [],
    parse: (raw) => ConnectionList.parse(raw).items,
  });

  readonly accounts = httpResource<Account[]>(() => '/api/accounts', {
    defaultValue: [],
    parse: (raw) => AccountList.parse(raw).items,
  });

  readonly recentTransactions = httpResource<TransactionPage | undefined>(
    () => ({ url: '/api/transactions', params: { limit: '8' } }),
    { parse: (raw) => TransactionPage.parse(raw) },
  );

  /** Account ids with a refresh in flight, so their buttons can show progress. */
  readonly refreshing = signal<ReadonlySet<string>>(new Set());

  constructor() {
    inject(EventStream)
      .stream.pipe(takeUntilDestroyed())
      .subscribe((event) => {
        if (event.type === 'connection.updated') this.reload();
      });
  }

  reload(): void {
    this.connections.reload();
    this.accounts.reload();
    this.recentTransactions.reload();
  }

  /** The one user-initiated bank call from the dashboard. Rejects with an `ApiError` the caller maps to a designed state. */
  async refreshAccount(accountId: string): Promise<RefreshAccountResponse> {
    this.refreshing.update((set) => new Set(set).add(accountId));
    try {
      const result = RefreshAccountResponse.parse(
        await firstValueFrom(this.http.post(`/api/accounts/${accountId}/refresh`, {})),
      );
      this.reload();
      return result;
    } finally {
      this.refreshing.update((set) => {
        const next = new Set(set);
        next.delete(accountId);
        return next;
      });
      // A failed refresh can still change the picture (the connection may now need a new sign-in).
      this.connections.reload();
    }
  }
}
