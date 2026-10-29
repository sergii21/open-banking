import { Component, computed, input } from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import type { RecurringPayment } from '@ledger-lens/contracts';
import { CATEGORY_INFO } from '../../shared/categories';
import { formatDate } from '../../shared/format';
import { Money } from '../../shared/money/money';
import { CADENCE_LABEL, monthlyCommitment } from './insights-view';

/** Payments that come around on a rhythm (rent, subscriptions, insurance), with what they cost each month in all. */
@Component({
  selector: 'll-recurring-list',
  imports: [MatIcon, Money],
  template: `
    <p class="mb-3 text-sm text-on-surface-variant">
      About
      <ll-money
        class="font-semibold text-on-surface"
        [amountMinor]="total()"
        [currency]="currency()"
      />
      a month goes on these.
    </p>
    <ul class="m-0 list-none divide-y divide-outline-variant/60 p-0" data-testid="recurring-list">
      @for (payment of payments(); track payment.key) {
        <li class="flex items-center gap-3 py-3" data-testid="recurring-row">
          <span
            class="grid size-10 shrink-0 place-items-center rounded-full bg-secondary-container text-on-secondary-container"
          >
            <mat-icon aria-hidden="true">{{ icon(payment) }}</mat-icon>
          </span>
          <div class="min-w-0 flex-1">
            <p class="truncate font-medium">{{ payment.merchant }}</p>
            <p class="truncate text-sm text-on-surface-variant">
              {{ cadence(payment) }} · next around {{ next(payment) }}
            </p>
          </div>
          <div class="text-right">
            <ll-money
              class="font-medium"
              [amountMinor]="-payment.amount.amountMinor"
              [currency]="payment.amount.currency"
            />
            @if (payment.cadence !== 'monthly') {
              <p class="text-xs text-on-surface-variant">
                ≈
                <ll-money
                  [amountMinor]="payment.monthlyEquivalentMinor"
                  [currency]="payment.amount.currency"
                />
                a month
              </p>
            }
          </div>
        </li>
      }
    </ul>
  `,
  host: { class: 'block' },
})
export class RecurringList {
  readonly payments = input.required<readonly RecurringPayment[]>();
  readonly currency = input.required<string>();

  protected readonly total = computed(() => monthlyCommitment(this.payments()));
  protected icon = (payment: RecurringPayment): string => CATEGORY_INFO[payment.category].icon;
  protected cadence = (payment: RecurringPayment): string => CADENCE_LABEL[payment.cadence];
  protected next = (payment: RecurringPayment): string =>
    formatDate(payment.nextExpectedAt, 'medium');
}
