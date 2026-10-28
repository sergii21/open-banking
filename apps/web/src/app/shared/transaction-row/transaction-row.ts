import { Component, computed, input } from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import type { Transaction } from '@ledger-lens/contracts';
import { CATEGORY_INFO } from '../categories';
import { Money } from '../money/money';
import { StatusChip } from '../status-chip/status-chip';

/** One line of the transaction list; used on the dashboard and the full list. */
@Component({
  selector: 'll-transaction-row',
  imports: [MatIcon, Money, StatusChip],
  template: `
    <div
      class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 py-3 md:grid-cols-[auto_minmax(0,1fr)_9rem_7.5rem]"
    >
      <span
        class="grid size-10 place-items-center rounded-full bg-secondary-container text-on-secondary-container"
      >
        <mat-icon>{{ info().icon }}</mat-icon>
      </span>
      <div class="min-w-0">
        <p class="truncate font-medium" data-testid="txn-title">{{ title() }}</p>
        <p class="truncate text-sm text-on-surface-variant">{{ subtitle() }}</p>
      </div>
      <span class="hidden text-sm text-on-surface-variant md:block">{{ info().label }}</span>
      <div class="flex flex-col items-end gap-1">
        <ll-money
          class="font-medium"
          [amountMinor]="transaction().amount.amountMinor"
          [currency]="transaction().amount.currency"
          [signed]="true"
          colorize="positive"
        />
        @if (transaction().status === 'pending') {
          <ll-status-chip tone="neutral" icon="schedule">Pending</ll-status-chip>
        }
      </div>
    </div>
  `,
  host: { class: 'block' },
})
export class TransactionRow {
  readonly transaction = input.required<Transaction>();
  /** Shown after the description when several accounts are listed together. */
  readonly accountName = input<string | null>(null);

  protected readonly info = computed(() => CATEGORY_INFO[this.transaction().category]);
  protected readonly title = computed(
    () => this.transaction().counterparty ?? this.transaction().description,
  );
  protected readonly subtitle = computed(() => {
    const t = this.transaction();
    const detail = t.counterparty ? t.description : this.info().label;
    const account = this.accountName();
    return account ? `${detail} · ${account}` : detail;
  });
}
