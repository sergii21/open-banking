import { Component, input, model } from '@angular/core';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

/**
 * A two-or-three way switch (a radio group that looks like buttons). It replaces Material's button toggle, which pulls a
 * lot of code into the initial bundle for what is a pair of buttons. Arrow keys move the selection, as in any radio group.
 */
@Component({
  selector: 'll-segmented',
  template: `
    <div
      role="radiogroup"
      class="flex overflow-hidden rounded-full border border-outline"
      [attr.aria-label]="label()"
    >
      @for (option of options(); track option.value; let i = $index) {
        <button
          type="button"
          role="radio"
          class="min-h-9 flex-1 px-4 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
          [class]="
            value() === option.value
              ? 'bg-secondary-container text-on-secondary-container'
              : 'text-on-surface hover:bg-surface-container'
          "
          [class.border-l]="i > 0"
          [class.border-outline]="i > 0"
          [attr.aria-checked]="value() === option.value"
          [tabindex]="value() === option.value ? 0 : -1"
          (click)="value.set(option.value)"
          (keydown.arrowright)="move($event, i + 1)"
          (keydown.arrowdown)="move($event, i + 1)"
          (keydown.arrowleft)="move($event, i - 1)"
          (keydown.arrowup)="move($event, i - 1)"
        >
          {{ option.label }}
        </button>
      }
    </div>
  `,
  host: { class: 'block' },
})
export class Segmented<T extends string> {
  readonly label = input.required<string>();
  readonly options = input.required<readonly SegmentOption<T>[]>();
  readonly value = model.required<T>();

  protected move(event: Event, target: number): void {
    const options = this.options();
    const next = options[(target + options.length) % options.length];
    if (!next) return;
    event.preventDefault();
    this.value.set(next.value);
    const buttons = (event.currentTarget as HTMLElement).parentElement?.children;
    (buttons?.[options.indexOf(next)] as HTMLElement | undefined)?.focus();
  }
}
