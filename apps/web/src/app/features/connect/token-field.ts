import { Component, input, output, signal } from '@angular/core';
import { MatButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import type { Institution } from '@ledger-lens/contracts';

type TokenHelp = NonNullable<Institution['tokenHelp']>;

/** Where to get a personal token and where to paste it. The value never leaves this component except through `submitted`. */
@Component({
  selector: 'll-token-field',
  imports: [MatButton, MatIcon],
  template: `
    <section
      class="mt-6 rounded-2xl border border-outline-variant bg-surface-container-low p-5"
      aria-labelledby="token-title"
    >
      <h2 id="token-title" class="font-semibold">Get your {{ bankName() }} token</h2>
      <ol class="mt-2 list-decimal space-y-1 pl-5 text-sm text-on-surface-variant">
        @for (step of help().steps; track step) {
          <li>{{ step }}</li>
        }
      </ol>
      <a
        class="mt-3 inline-flex items-center gap-1 text-sm"
        [href]="help().url"
        target="_blank"
        rel="noopener noreferrer"
      >
        Open {{ help().url }}
        <mat-icon class="!size-4 !text-base" aria-hidden="true">open_in_new</mat-icon>
        <span class="sr-only">(opens in a new tab)</span>
      </a>

      <form class="mt-4" (submit)="submit($event)" novalidate>
        <label for="token-input" class="block text-sm font-medium">{{ bankName() }} token</label>
        <input
          id="token-input"
          name="token"
          type="password"
          class="mt-1 block w-full rounded-xl border border-outline bg-surface px-3 py-3 font-mono text-sm text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          [value]="value()"
          [attr.aria-invalid]="error() ? 'true' : null"
          [attr.aria-describedby]="error() ? 'token-error token-hint' : 'token-hint'"
          (input)="onInput($event)"
          data-testid="token-input"
        />
        <p id="token-hint" class="mt-1 text-xs text-on-surface-variant">
          Encrypted on this machine. Never shown again, never sent to the browser after this.
        </p>
        @if (error(); as message) {
          <p
            id="token-error"
            class="mt-2 text-sm text-error"
            role="alert"
            data-testid="token-error"
          >
            {{ message }}
          </p>
        }
        <p class="mt-3 text-xs text-on-surface-variant">{{ help().revokeNote }}</p>

        <div class="mt-4 flex flex-wrap items-center gap-3">
          <button
            mat-flat-button
            type="submit"
            class="!h-12"
            [disabled]="busy() || value().trim().length < 8"
            data-testid="connect-with-token"
          >
            <ng-content />
          </button>
        </div>
      </form>
    </section>
  `,
})
export class TokenField {
  readonly bankName = input.required<string>();
  readonly help = input.required<TokenHelp>();
  readonly busy = input(false);
  readonly error = input<string | null>(null);
  readonly submitted = output<string>();

  protected readonly value = signal('');

  protected onInput(event: Event): void {
    this.value.set((event.target as HTMLInputElement).value);
  }

  protected submit(event: Event): void {
    event.preventDefault();
    const token = this.value().trim();
    if (token.length >= 8 && !this.busy()) this.submitted.emit(token);
  }
}
