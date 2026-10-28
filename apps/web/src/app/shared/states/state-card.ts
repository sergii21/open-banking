import { Component, input } from '@angular/core';
import { MatIcon } from '@angular/material/icon';

/**
 * One layout for every designed state: empty, error, success. Pages project their action buttons into it so
 * recovery is always one click away.
 */
@Component({
  selector: 'll-state',
  imports: [MatIcon],
  template: `
    <div
      class="flex flex-col items-center gap-3 rounded-3xl border border-outline-variant bg-surface-container-low p-8 text-center"
      [attr.role]="role()"
    >
      <span
        class="grid size-16 place-items-center rounded-full"
        [class]="
          tone() === 'error'
            ? 'bg-error-container text-on-error-container'
            : tone() === 'success'
              ? 'bg-positive-container text-on-positive-container'
              : tone() === 'warning'
                ? 'bg-warning-container text-on-warning-container'
                : 'bg-primary-container text-on-primary-container'
        "
      >
        <mat-icon class="!size-8 !text-[32px]">{{ icon() }}</mat-icon>
      </span>
      <h2 class="text-xl font-semibold tracking-tight">{{ title() }}</h2>
      <p class="max-w-prose text-on-surface-variant">{{ message() }}</p>
      <div class="flex flex-wrap items-center justify-center gap-2 pt-2">
        <ng-content />
      </div>
    </div>
  `,
  host: { class: 'block' },
})
export class StateCard {
  readonly icon = input.required<string>();
  readonly title = input.required<string>();
  readonly message = input.required<string>();
  readonly tone = input<'neutral' | 'success' | 'warning' | 'error'>('neutral');
  /** `alert` for errors that interrupt, `status` for polite updates, null for static empty states. */
  readonly role = input<'alert' | 'status' | null>(null);
}
