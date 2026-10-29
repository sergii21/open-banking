import { Component, input } from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { Money } from '../money/money';

/**
 * One headline number: a sentence-case label, the value, and a line saying what it is. Where the value has a direction
 * (net: kept or overspent) the caption says so in words and an icon repeats it, so the sign never rests on colour alone.
 */
@Component({
  selector: 'll-stat-tile',
  imports: [MatIcon, Money],
  template: `
    <p class="text-sm text-on-surface-variant">{{ label() }}</p>
    <p class="mt-1 text-3xl font-semibold tracking-tight">
      <!-- A big standalone figure takes proportional digits; tabular ones are for columns that must line up. -->
      <ll-money
        class="!normal-nums"
        [amountMinor]="amountMinor()"
        [currency]="currency()"
        [signed]="signed()"
        [colorize]="colorize()"
      />
    </p>
    @if (caption()) {
      <p class="mt-1 flex items-center gap-1 text-sm text-on-surface-variant">
        @if (icon(); as name) {
          <mat-icon class="!size-4 !text-base" aria-hidden="true">{{ name }}</mat-icon>
        }
        {{ caption() }}
      </p>
    }
  `,
  host: {
    class: 'block min-w-0 rounded-3xl border border-outline-variant bg-surface-container-low p-5',
  },
})
export class StatTile {
  readonly label = input.required<string>();
  readonly amountMinor = input.required<number>();
  readonly currency = input.required<string>();
  readonly caption = input<string | null>(null);
  readonly icon = input<string | null>(null);
  readonly signed = input(false);
  readonly colorize = input<'none' | 'positive' | 'both'>('none');
}
