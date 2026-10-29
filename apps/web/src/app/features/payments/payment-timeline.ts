import { Component, computed, input } from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import type { Payment } from '@ledger-lens/contracts';
import { RelativeTime } from '../../shared/relative-time/relative-time';
import { buildTimeline, type StepState } from './payment-view';

const ICON: Record<StepState, string> = {
  done: 'check_circle',
  current: 'hourglass_top',
  failed: 'cancel',
  upcoming: 'radio_button_unchecked',
};

const SPOKEN: Record<StepState, string> = {
  done: 'done',
  current: 'in progress',
  failed: 'did not happen',
  upcoming: 'not yet',
};

/** The steps a payment goes through, with where it is now. Text carries every state; colour only reinforces it. */
@Component({
  selector: 'll-payment-timeline',
  imports: [MatIcon, RelativeTime],
  template: `
    <ol class="m-0 list-none p-0" aria-label="Payment progress" data-testid="timeline">
      @for (step of steps(); track step.status; let last = $last) {
        <li
          class="flex gap-3"
          [attr.aria-current]="step.state === 'current' ? 'step' : null"
          [attr.data-testid]="'step-' + step.status"
          [attr.data-state]="step.state"
        >
          <div class="flex flex-col items-center">
            <span
              class="grid size-9 shrink-0 place-items-center rounded-full"
              [class]="
                step.state === 'done'
                  ? 'bg-positive-container text-on-positive-container'
                  : step.state === 'current'
                    ? 'bg-warning-container text-on-warning-container'
                    : step.state === 'failed'
                      ? 'bg-error-container text-on-error-container'
                      : 'bg-surface-container-high text-on-surface-variant'
              "
            >
              <mat-icon aria-hidden="true">{{ icon[step.state] }}</mat-icon>
            </span>
            @if (!last) {
              <span
                class="my-1 w-0.5 flex-1 rounded-full"
                [class]="step.state === 'done' ? 'bg-positive' : 'bg-outline-variant'"
                aria-hidden="true"
              ></span>
            }
          </div>
          <div class="min-w-0 pb-5" [class.pb-0]="last">
            <p class="font-medium">
              {{ step.label }}
              <span class="sr-only"> — {{ spoken[step.state] }}</span>
            </p>
            <p class="text-sm text-on-surface-variant">{{ step.hint }}</p>
            @if (step.at) {
              <p class="text-xs text-on-surface-variant">
                <ll-relative-time [at]="step.at" />
              </p>
            }
          </div>
        </li>
      }
    </ol>
  `,
  host: { class: 'block' },
})
export class PaymentTimeline {
  readonly payment = input.required<Payment>();

  protected readonly icon = ICON;
  protected readonly spoken = SPOKEN;
  protected readonly steps = computed(() => buildTimeline(this.payment()));
}
