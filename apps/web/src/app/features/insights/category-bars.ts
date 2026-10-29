import { Component, computed, input } from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import type { CategoryTotal } from '@ledger-lens/contracts';
import { CATEGORY_INFO } from '../../shared/categories';
import { Money } from '../../shared/money/money';

/**
 * Spending by category as a bar list. Thirteen nominal categories are too many for a pie and need no colour to tell them
 * apart, so every bar wears the one series colour and the name sits beside it; the list is its own table view, because each
 * row states its amount and share in text. Bars are measured against the biggest category, so they use the full width.
 */
@Component({
  selector: 'll-category-bars',
  imports: [MatIcon, Money],
  template: `
    <ul class="m-0 list-none space-y-3 p-0" data-testid="category-bars">
      @for (row of rows(); track row.category) {
        <li data-testid="category-row" [attr.data-category]="row.category">
          <div class="flex items-baseline justify-between gap-3">
            <span class="flex min-w-0 items-center gap-2">
              <mat-icon
                class="!size-5 shrink-0 !text-xl text-on-surface-variant"
                aria-hidden="true"
                >{{ row.icon }}</mat-icon
              >
              <span class="truncate font-medium">{{ row.label }}</span>
              <span class="shrink-0 text-xs text-on-surface-variant"
                >{{ row.count }} {{ row.count === 1 ? 'payment' : 'payments' }}</span
              >
            </span>
            <span class="flex shrink-0 items-baseline gap-2 text-sm">
              <ll-money
                class="font-medium"
                [amountMinor]="row.spentMinor"
                [currency]="currency()"
              />
              <span
                class="w-10 text-right text-on-surface-variant"
                [attr.aria-label]="row.percent + ' percent'"
                >{{ row.percent }}%</span
              >
            </span>
          </div>
          <div class="mt-1.5 h-2 rounded-full bg-surface-container-high" aria-hidden="true">
            <div class="h-full rounded-full bg-series-1" [style.width.%]="row.width"></div>
          </div>
        </li>
      }
    </ul>
  `,
  host: { class: 'block' },
})
export class CategoryBars {
  readonly categories = input.required<readonly CategoryTotal[]>();
  readonly currency = input.required<string>();

  protected readonly rows = computed(() => {
    const categories = this.categories();
    const biggest = Math.max(1, ...categories.map((category) => category.spentMinor));
    return categories.map((category) => ({
      ...category,
      label: CATEGORY_INFO[category.category].label,
      icon: CATEGORY_INFO[category.category].icon,
      percent: Math.round(category.share * 100),
      width: Math.max(2, (category.spentMinor / biggest) * 100),
    }));
  });
}
