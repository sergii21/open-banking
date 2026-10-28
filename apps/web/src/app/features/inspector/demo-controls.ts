import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { MatButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { DemoActionResponse, type DemoAction } from '@ledger-lens/contracts';
import { firstValueFrom } from 'rxjs';
import { toApiError } from '../../core/api/api-error';
import { Data } from '../../core/data/data';

interface ActionSpec {
  action: DemoAction;
  label: string;
  icon: string;
  hint: string;
}

const ACTIONS: readonly ActionSpec[] = [
  {
    action: 'bank_unavailable_next',
    label: 'Bank outage',
    icon: 'cloud_off',
    hint: 'The next call to the bank fails with 503.',
  },
  {
    action: 'rate_limit_next',
    label: 'Rate limit',
    icon: 'speed',
    hint: 'The next call is refused with 429 and a retry hint.',
  },
  {
    action: 'revoke_at_bank',
    label: 'Revoke at bank',
    icon: 'link_off',
    hint: 'The customer withdraws consent in their banking app.',
  },
  {
    action: 'expire_consent_soon',
    label: 'Consent ends in 2 days',
    icon: 'event_upcoming',
    hint: 'Shows the expiry reminder and reconnect.',
  },
  {
    action: 'expire_consent_now',
    label: 'Consent ended',
    icon: 'event_busy',
    hint: 'The bank-side consent has just ended.',
  },
];

/** Failure states on demand, for the mock bank. Only shown when the server has demo controls enabled. */
@Component({
  selector: 'll-demo-controls',
  imports: [MatButton, MatIcon],
  template: `
    <section class="p-2" aria-labelledby="demo-title">
      <h3 id="demo-title" class="text-sm font-semibold">
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left hover:bg-surface-container"
          [attr.aria-expanded]="open()"
          aria-controls="demo-panel"
          data-testid="demo-toggle"
          (click)="open.set(!open())"
        >
          <mat-icon aria-hidden="true" class="!size-5 !text-xl">science</mat-icon>
          <span class="flex-1">Demo controls</span>
          <span class="text-xs font-normal text-on-surface-variant">break things on purpose</span>
          <mat-icon aria-hidden="true">{{ open() ? 'expand_more' : 'expand_less' }}</mat-icon>
        </button>
      </h3>
      @if (open()) {
        <div id="demo-panel" class="space-y-2 px-2 pt-1 pb-2">
          @if (target(); as connection) {
            <p class="text-xs text-on-surface-variant">
              Acts on {{ connection.institutionName }}. Then press Refresh on an account.
            </p>
            <div class="flex flex-wrap gap-2">
              @for (item of actions; track item.action) {
                <button
                  mat-stroked-button
                  type="button"
                  class="!h-9 !text-xs"
                  [disabled]="busy()"
                  [attr.aria-description]="item.hint"
                  [attr.data-testid]="'demo-' + item.action"
                  (click)="run(item.action, connection.id)"
                >
                  <mat-icon>{{ item.icon }}</mat-icon>
                  {{ item.label }}
                </button>
              }
            </div>
          } @else {
            <p class="text-xs text-on-surface-variant">
              Connect the mock bank to break things on purpose.
            </p>
          }
        </div>
      }
    </section>
  `,
  host: { class: 'block' },
})
export class DemoControls {
  private readonly http = inject(HttpClient);
  private readonly data = inject(Data);
  private readonly snackBar = inject(MatSnackBar);

  protected readonly actions = ACTIONS;
  protected readonly open = signal(false);
  protected readonly busy = signal(false);
  protected readonly target = computed(
    () =>
      this.data.connections.value().find((connection) => connection.provider === 'mock') ?? null,
  );

  protected async run(action: DemoAction, connectionId: string): Promise<void> {
    this.busy.set(true);
    try {
      const response = DemoActionResponse.parse(
        await firstValueFrom(this.http.post('/api/demo/actions', { action, connectionId })),
      );
      this.snackBar.open(response.message, 'OK', { duration: 6000 });
      this.data.reload();
    } catch (error) {
      this.snackBar.open(toApiError(error).message, 'OK', { duration: 6000 });
    } finally {
      this.busy.set(false);
    }
  }
}
