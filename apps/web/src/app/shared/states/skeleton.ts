import { Component, input } from '@angular/core';

/** A shimmering placeholder block. Hidden from assistive tech; the page announces loading through its own status text. */
@Component({
  selector: 'll-skeleton',
  template: '',
  host: {
    class: 'block animate-pulse rounded-lg bg-surface-container-high',
    'aria-hidden': 'true',
    '[style.height]': 'height()',
    '[style.width]': 'width()',
  },
})
export class Skeleton {
  readonly height = input('1rem');
  readonly width = input('100%');
}
