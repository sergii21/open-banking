import { Component, computed, input, output } from '@angular/core';
import { MatIconButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatMenu, MatMenuItem, MatMenuTrigger } from '@angular/material/menu';
import { CATEGORIES, type Category, type Transaction } from '@ledger-lens/contracts';
import { CATEGORY_INFO } from '../categories';
import { Money } from '../money/money';
import { StatusChip } from '../status-chip/status-chip';

/** One line of the transaction list; used on the dashboard and the full list. */
@Component({
  selector: 'll-transaction-row',
  imports: [MatIcon, MatIconButton, MatMenu, MatMenuItem, MatMenuTrigger, Money, StatusChip],
  template: `
    <div
      class="grid items-center gap-x-3 py-3"
      [class]="
        editable()
          ? 'grid-cols-[auto_minmax(0,1fr)_auto_auto] md:grid-cols-[auto_minmax(0,1fr)_9rem_7.5rem_auto]'
          : 'grid-cols-[auto_minmax(0,1fr)_auto] md:grid-cols-[auto_minmax(0,1fr)_9rem_7.5rem]'
      "
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
      <span class="hidden text-sm text-on-surface-variant md:block" data-testid="txn-category">
        {{ info().label }}
        @if (transaction().categorySource === 'user') {
          <mat-icon class="!size-4 align-text-bottom !text-base" aria-hidden="true">edit</mat-icon>
          <span class="sr-only">(chosen by you)</span>
        }
      </span>
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
      @if (editable()) {
        <button
          mat-icon-button
          type="button"
          [matMenuTriggerFor]="menu"
          [attr.aria-label]="'Change category of ' + title()"
          data-testid="change-category"
        >
          <mat-icon>label</mat-icon>
        </button>
        <mat-menu #menu="matMenu" aria-label="Choose a category">
          @for (category of categories; track category) {
            <button
              mat-menu-item
              type="button"
              [attr.data-testid]="'category-' + category"
              (click)="categoryChange.emit(category)"
            >
              <mat-icon>{{ categoryInfo[category].icon }}</mat-icon>
              <span>{{ categoryInfo[category].label }}</span>
              @if (category === transaction().category) {
                <span class="sr-only">(current)</span>
              }
            </button>
          }
        </mat-menu>
      }
    </div>
  `,
  host: { class: 'block' },
})
export class TransactionRow {
  readonly transaction = input.required<Transaction>();
  /** Shown after the description when several accounts are listed together. */
  readonly accountName = input<string | null>(null);
  /** Lets the customer file the transaction under another category. */
  readonly editable = input(false);
  readonly categoryChange = output<Category>();

  protected readonly categories = CATEGORIES;
  protected readonly categoryInfo = CATEGORY_INFO;

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
