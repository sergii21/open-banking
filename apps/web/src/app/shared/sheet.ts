import { Component, effect, ElementRef, input, model, viewChild } from '@angular/core';
import { Icon } from './icon';

let nextId = 0;

/** A bottom sheet on a phone and a centred dialog on a desktop: the native <dialog>, so focus, Escape and inertness are the browser's. */
@Component({
  selector: 'll-sheet',
  imports: [Icon],
  template: `
    <dialog
      #dialog
      class="sheet"
      [attr.aria-labelledby]="id"
      (close)="open.set(false)"
      (click)="onBackdrop($event)"
    >
      <div class="sheet-head">
        <h2 [id]="id">{{ title() }}</h2>
        <button type="button" class="icon-btn" aria-label="Close" (click)="open.set(false)">
          <ll-icon name="x" />
        </button>
      </div>
      <div class="sheet-body"><ng-content /></div>
    </dialog>
  `,
})
export class Sheet {
  readonly open = model(false);
  readonly title = input.required<string>();
  protected readonly id = `sheet-${nextId++}`;
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  constructor() {
    effect(() => {
      const element = this.dialog().nativeElement;
      if (this.open() && !element.open) element.showModal();
      else if (!this.open() && element.open) element.close();
    });
  }

  /** A click on the dimmed area outside the sheet lands on the <dialog> element itself. */
  protected onBackdrop(event: MouseEvent): void {
    if (event.target === this.dialog().nativeElement) this.open.set(false);
  }
}
