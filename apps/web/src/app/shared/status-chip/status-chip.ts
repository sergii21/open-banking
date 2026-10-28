import { Component, computed, input } from '@angular/core';
import { MatIcon } from '@angular/material/icon';

export type Tone = 'success' | 'warning' | 'error' | 'info' | 'neutral';

const TONE_CLASSES: Record<Tone, string> = {
  success: 'bg-positive-container text-on-positive-container',
  warning: 'bg-warning-container text-on-warning-container',
  error: 'bg-error-container text-on-error-container',
  info: 'bg-secondary-container text-on-secondary-container',
  neutral: 'bg-surface-container-high text-on-surface-variant',
};

/** A status pill. Always carries text (and usually an icon): colour alone never carries the meaning. */
@Component({
  selector: 'll-status-chip',
  imports: [MatIcon],
  template: `
    @if (icon(); as name) {
      <mat-icon class="!size-4 !text-base">{{ name }}</mat-icon>
    }
    <ng-content />
  `,
  host: {
    class:
      'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap',
    '[class]': 'toneClass()',
  },
})
export class StatusChip {
  readonly tone = input<Tone>('neutral');
  readonly icon = input<string | null>(null);

  protected readonly toneClass = computed(() => TONE_CLASSES[this.tone()]);
}
