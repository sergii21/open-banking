import { Component, computed, inject, input } from '@angular/core';
import { Ticker } from '../../core/clock/ticker';
import { formatDateTime, formatRelative } from '../format';

/** "3 minutes ago" that keeps itself current, with the exact time on hover and in the datetime attribute. */
@Component({
  selector: 'll-relative-time',
  template: '<time [attr.datetime]="at()" [title]="exact()">{{ text() }}</time>',
})
export class RelativeTime {
  private readonly ticker = inject(Ticker);

  readonly at = input.required<string>();

  protected readonly text = computed(() =>
    formatRelative(Date.parse(this.at()), this.ticker.now()),
  );
  protected readonly exact = computed(() => formatDateTime(this.at()));
}
