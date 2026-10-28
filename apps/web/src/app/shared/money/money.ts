import { Component, computed, input } from '@angular/core';
import { formatMoney } from '../format';

/**
 * An amount in integer minor units. `colorize` adds colour on top of the sign character, never instead of it, so the
 * meaning survives for colour-blind readers and in forced-colour modes.
 */
@Component({
  selector: 'll-money',
  template: '{{ text() }}',
  host: {
    class: 'tabular whitespace-nowrap',
    '[class.text-positive]': 'tone() === "positive"',
    '[class.text-negative]': 'tone() === "negative"',
    '[attr.data-amount-minor]': 'amountMinor()',
    '[attr.data-currency]': 'currency()',
  },
})
export class Money {
  readonly amountMinor = input.required<number>();
  readonly currency = input.required<string>();
  /** Show "+" for money in. Negative amounts always show "-". */
  readonly signed = input(false);
  readonly colorize = input<'none' | 'positive' | 'both'>('none');

  protected readonly text = computed(() =>
    formatMoney(this.amountMinor(), this.currency(), this.signed()),
  );
  protected readonly tone = computed(() => {
    const mode = this.colorize();
    const amount = this.amountMinor();
    if (mode === 'none' || amount === 0) return 'none';
    if (amount > 0) return 'positive';
    return mode === 'both' ? 'negative' : 'none';
  });
}
