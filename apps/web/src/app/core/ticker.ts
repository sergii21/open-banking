import { Service, signal } from '@angular/core';

/** "Now", once a second, for the countdowns and the "updated 12 s ago" text. Only what reads it re-renders. */
@Service()
export class Ticker {
  readonly now = signal(Date.now());

  constructor() {
    setInterval(() => this.now.set(Date.now()), 1000);
  }
}
