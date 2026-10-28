import { DestroyRef, inject, Service, signal } from '@angular/core';

/** A shared once-a-second clock, so relative times ("3 min ago") and cool-down countdowns stay current. */
@Service()
export class Ticker {
  /** Epoch milliseconds. */
  readonly now = signal(Date.now());

  constructor() {
    const timer = setInterval(() => {
      this.now.set(Date.now());
    }, 1000);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(timer);
    });
  }
}
