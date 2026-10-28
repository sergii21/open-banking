import { Component, computed, inject, input } from '@angular/core';
import { MatIconButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltip } from '@angular/material/tooltip';
import { RouterLink } from '@angular/router';
import type { Account, AccountType, Connection } from '@ledger-lens/contracts';
import { describeError } from '../../core/api/api-error';
import { Ticker } from '../../core/clock/ticker';
import { Data } from '../../core/data/data';
import { SessionService } from '../../core/session/session';
import { BankLogo } from '../../shared/bank-logo/bank-logo';
import { Money } from '../../shared/money/money';
import { RelativeTime } from '../../shared/relative-time/relative-time';
import { StatusChip } from '../../shared/status-chip/status-chip';

const TYPE_INFO: Record<AccountType, { label: string; icon: string }> = {
  current: { label: 'Current', icon: 'account_balance_wallet' },
  savings: { label: 'Savings', icon: 'savings' },
  credit_card: { label: 'Credit card', icon: 'credit_card' },
  other: { label: 'Account', icon: 'account_balance' },
};

@Component({
  selector: 'll-account-card',
  imports: [
    BankLogo,
    MatIcon,
    MatIconButton,
    MatProgressSpinner,
    MatTooltip,
    Money,
    RelativeTime,
    RouterLink,
    StatusChip,
  ],
  template: `
    <article
      class="flex h-full flex-col gap-4 rounded-3xl border border-outline-variant bg-surface-container-low p-5"
      [attr.aria-label]="account().name + ' at ' + account().institutionName"
      data-testid="account-card"
    >
      <header class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0.5">
        <ll-bank-logo
          class="row-span-2"
          [src]="connection()?.institutionLogoUrl ?? null"
          [name]="account().institutionName"
          [size]="40"
        />
        <h3 class="truncate font-semibold" data-testid="account-name">{{ account().name }}</h3>
        <ll-status-chip tone="neutral" [icon]="type().icon">{{ type().label }}</ll-status-chip>
        <p class="col-span-2 text-sm text-on-surface-variant">
          {{ account().institutionName }}
          @if (account().maskedIdentifier; as masked) {
            <span class="tabular whitespace-nowrap" data-testid="account-identifier"
              >· {{ masked }}</span
            >
          }
        </p>
      </header>

      <div>
        <p class="text-3xl font-semibold tracking-tight" data-testid="account-balance">
          <ll-money
            [amountMinor]="account().balance.amountMinor"
            [currency]="account().balance.currency"
          />
        </p>
        @if (account().availableBalance; as available) {
          <p class="text-sm text-on-surface-variant">
            {{ account().type === 'credit_card' ? 'Credit available' : 'Available' }}
            <ll-money [amountMinor]="available.amountMinor" [currency]="available.currency" />
          </p>
        }
      </div>

      <footer
        class="mt-auto flex items-end justify-between gap-2 border-t border-outline-variant pt-3 text-on-surface-variant"
      >
        <span class="min-w-0">
          <span class="block text-xs"
            >Updated <ll-relative-time [at]="account().lastRefreshedAt"
          /></span>
        </span>
        <span class="flex shrink-0 items-center gap-1 text-sm">
          <a
            [routerLink]="['/transactions']"
            [queryParams]="{ account: account().id }"
            class="rounded-full px-2 py-1"
            [attr.aria-label]="'View transactions for ' + account().name"
          >
            Transactions
          </a>
          <button
            mat-icon-button
            type="button"
            [disabled]="!canRefresh()"
            [attr.aria-label]="refreshLabel()"
            [matTooltip]="refreshLabel()"
            data-testid="refresh-account"
            (click)="refresh()"
          >
            @if (refreshing()) {
              <mat-spinner diameter="20" aria-hidden="true" />
            } @else {
              <mat-icon>refresh</mat-icon>
            }
          </button>
        </span>
      </footer>
    </article>
  `,
  host: { class: 'block' },
})
export class AccountCard {
  private readonly data = inject(Data);
  private readonly ticker = inject(Ticker);
  private readonly session = inject(SessionService);
  private readonly snackBar = inject(MatSnackBar);

  readonly account = input.required<Account>();
  readonly connection = input<Connection | undefined>(undefined);

  protected readonly type = computed(() => TYPE_INFO[this.account().type]);
  protected readonly refreshing = computed(() => this.data.refreshing().has(this.account().id));

  /** Seconds until the server will accept another refresh; the server enforces it, the button just reflects it. */
  protected readonly cooldownLeft = computed(() => {
    const readyAt =
      Date.parse(this.account().lastRefreshedAt) + this.session.cooldownSeconds() * 1000;
    return Math.max(0, Math.ceil((readyAt - this.ticker.now()) / 1000));
  });
  protected readonly canRefresh = computed(
    () => this.connection()?.status === 'active' && !this.refreshing() && this.cooldownLeft() === 0,
  );
  protected readonly refreshLabel = computed(() => {
    const name = this.account().name;
    if (this.refreshing()) return `Refreshing ${name}…`;
    if (this.connection()?.status !== 'active')
      return `Reconnect ${this.account().institutionName} to refresh ${name}`;
    return this.cooldownLeft() > 0
      ? `Refresh ${name} (available in ${this.cooldownLeft()} s)`
      : `Refresh ${name}`;
  });

  protected async refresh(): Promise<void> {
    try {
      const result = await this.data.refreshAccount(this.account().id);
      const added = result.newTransactions;
      this.snackBar.open(
        `${this.account().name} updated${added > 0 ? `: ${added} new transaction${added === 1 ? '' : 's'}` : '. Nothing new.'}`,
        'OK',
        { duration: 5000 },
      );
    } catch (error) {
      const copy = describeError(error);
      this.snackBar.open(`${copy.title}. ${copy.message}`, 'OK', { duration: 9000 });
    }
  }
}
