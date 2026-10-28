import { Component, computed, inject } from '@angular/core';
import { MatButton } from '@angular/material/button';
import { RouterOutlet } from '@angular/router';
import { describeError } from './core/api/api-error';
import { SessionService } from './core/session/session';
import { StateCard } from './shared/states/state-card';

@Component({
  selector: 'll-root',
  imports: [MatButton, RouterOutlet, StateCard],
  template: `
    @if (session.error(); as error) {
      <main class="mx-auto max-w-xl px-4 pt-24">
        <ll-state
          [icon]="copy().icon"
          [title]="copy().title"
          [message]="copy().message"
          tone="error"
          role="alert"
        >
          <button
            mat-flat-button
            type="button"
            data-testid="boot-retry"
            (click)="session.bootstrap()"
          >
            Try again
          </button>
        </ll-state>
        <p class="mt-3 text-center text-sm text-on-surface-variant">{{ error.message }}</p>
      </main>
    } @else {
      <router-outlet />
    }
  `,
})
export class App {
  protected readonly session = inject(SessionService);
  protected readonly copy = computed(() => describeError(this.session.error()));
}
