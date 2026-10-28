import { Component, computed, inject, input } from '@angular/core';
import { MatButton } from '@angular/material/button';
import { RouterLink } from '@angular/router';
import { ConnectOutcome } from '@ledger-lens/contracts';
import { Data } from '../../core/data/data';
import { StateCard } from '../../shared/states/state-card';
import { Money } from '../../shared/money/money';

interface OutcomeCopy {
  icon: string;
  tone: 'success' | 'warning' | 'error' | 'neutral';
  title: string;
  message: string;
  role: 'status' | 'alert';
}

const OUTCOMES: Record<ConnectOutcome, OutcomeCopy> = {
  success: {
    icon: 'check_circle',
    tone: 'success',
    title: 'Bank connected',
    message: 'Your accounts and recent transactions are ready.',
    role: 'status',
  },
  denied: {
    icon: 'do_not_disturb_on',
    tone: 'neutral',
    title: 'You didn’t give access',
    message:
      'No problem. Nothing was shared and nothing was saved. You can try again whenever you like.',
    role: 'status',
  },
  timeout: {
    icon: 'timer_off',
    tone: 'warning',
    title: 'Approval at your bank timed out',
    message:
      'Banks require strong authentication within a few minutes, and it wasn’t completed in time. Open your banking app when prompted and try again.',
    role: 'alert',
  },
  unavailable: {
    icon: 'cloud_off',
    tone: 'error',
    title: 'Your bank isn’t available right now',
    message:
      'The bank couldn’t be reached to finish the connection, so nothing was saved. Try again in a few minutes, or use another bank.',
    role: 'alert',
  },
  invalid_state: {
    icon: 'link_off',
    tone: 'warning',
    title: 'This link has expired',
    message: 'For your security each bank redirect works once. Start again from the bank list.',
    role: 'alert',
  },
  error: {
    icon: 'error',
    tone: 'error',
    title: 'We couldn’t finish connecting',
    message:
      'Something went wrong while completing the connection. Nothing was saved. Please try again.',
    role: 'alert',
  },
};

/** Where the bank redirect lands (`/connect/result?status=…`). Every outcome has its own designed state. */
@Component({
  selector: 'll-connect-result',
  imports: [MatButton, Money, RouterLink, StateCard],
  template: `
    <div class="mx-auto max-w-xl pt-6">
      <ll-state
        [icon]="copy().icon"
        [title]="copy().title"
        [message]="copy().message"
        [tone]="copy().tone"
        [role]="copy().role"
        data-testid="connect-result"
      >
        @if (outcome() === 'success') {
          <a mat-flat-button routerLink="/dashboard" data-testid="go-dashboard">Go to dashboard</a>
          <a mat-stroked-button routerLink="/connections">View connections</a>
        } @else {
          <a mat-flat-button routerLink="/connect" data-testid="try-again">Try again</a>
          <a mat-stroked-button routerLink="/dashboard">Back to dashboard</a>
        }
      </ll-state>

      @if (outcome() === 'success' && accounts().length > 0) {
        <section class="mt-6" aria-label="Accounts found">
          <h2 class="mb-2 font-semibold">Accounts found</h2>
          <ul
            role="list"
            class="divide-y divide-outline-variant rounded-2xl border border-outline-variant"
          >
            @for (account of accounts(); track account.id) {
              <li class="flex items-center justify-between gap-3 px-4 py-3">
                <span>
                  <span class="block font-medium">{{ account.name }}</span>
                  <span class="block text-sm text-on-surface-variant">{{
                    account.maskedIdentifier
                  }}</span>
                </span>
                <ll-money
                  [amountMinor]="account.balance.amountMinor"
                  [currency]="account.balance.currency"
                  class="font-medium"
                />
              </li>
            }
          </ul>
        </section>
      }
    </div>
  `,
})
export class ConnectResult {
  private readonly data = inject(Data);

  /** Query params, bound by `withComponentInputBinding`. */
  readonly status = input<string | undefined>(undefined);
  readonly connection = input<string | undefined>(undefined);

  protected readonly outcome = computed<ConnectOutcome>(() => {
    const parsed = ConnectOutcome.safeParse(this.status());
    return parsed.success ? parsed.data : 'error';
  });
  protected readonly copy = computed(() => OUTCOMES[this.outcome()]);
  protected readonly accounts = computed(() =>
    this.data.accounts.value().filter((a) => a.connectionId === this.connection()),
  );

  constructor() {
    // Coming back from the bank: make sure the lists reflect what the callback just stored.
    this.data.reload();
  }
}
