import { Component, computed, input } from '@angular/core';
import { moneyParts } from '@ledger-lens/contracts';

/** An amount the Ukrainian way ("12 345,67 ₴"), with the kopiykas small and muted. Blurs when privacy mode is on. */
@Component({
  selector: 'll-amount',
  template: `{{ sign() }}{{ parts().whole
    }}@if (parts().fraction) {<span class="amt-frac">,{{ parts().fraction }}</span>}<span class="amt-cur">{{ parts().symbol }}</span>`,
  host: {
    class: 'amt',
    '[attr.data-size]': 'size()',
    '[class.in]': 'tone() && minor() > 0',
  },
})
export class Amount {
  readonly minor = input.required<number>();
  readonly currency = input('UAH');
  readonly size = input<'sm' | 'md' | 'lg' | 'xl' | 'hero'>('md');
  /** Show a plus on money in. */
  readonly plus = input(false);
  /** Colour money in green. */
  readonly tone = input(false);
  readonly fraction = input(true);

  protected readonly parts = computed(() => moneyParts(this.minor(), this.currency(), this.fraction()));
  protected readonly sign = computed(() =>
    this.parts().negative ? '−' : this.plus() && this.minor() > 0 ? '+' : '',
  );
}
