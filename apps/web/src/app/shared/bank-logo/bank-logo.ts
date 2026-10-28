import { NgOptimizedImage } from '@angular/common';
import { Component, computed, input, signal } from '@angular/core';

/** A bank's logo, falling back to a monogram when there is no image or it fails to load. */
@Component({
  selector: 'll-bank-logo',
  imports: [NgOptimizedImage],
  template: `
    @if (imageSrc(); as source) {
      <img
        [ngSrc]="source"
        [width]="size()"
        [height]="size()"
        alt=""
        class="rounded-xl"
        (error)="failed.set(true)"
      />
    } @else {
      <span
        class="grid place-items-center rounded-xl bg-primary-container font-semibold text-on-primary-container"
        [style.width.px]="size()"
        [style.height.px]="size()"
        aria-hidden="true"
      >
        {{ initials() }}
      </span>
    }
  `,
  host: { class: 'inline-flex shrink-0' },
})
export class BankLogo {
  readonly src = input<string | null>(null);
  readonly name = input.required<string>();
  readonly size = input(40);

  protected readonly failed = signal(false);
  protected readonly imageSrc = computed(() => (this.failed() ? null : this.src()));
  protected readonly initials = computed(() =>
    this.name()
      .split(/\s+/)
      .map((part) => part[0] ?? '')
      .join('')
      .slice(0, 2)
      .toUpperCase(),
  );
}
