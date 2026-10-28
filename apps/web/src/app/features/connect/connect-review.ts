import { HttpClient, httpResource } from '@angular/common/http';
import { DOCUMENT } from '@angular/common';
import { Component, computed, inject, input, signal } from '@angular/core';
import { MatButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { Router, RouterLink } from '@angular/router';
import {
  ConnectWithTokenResponse,
  CreateConnectionResponse,
  InstitutionList,
  type Institution,
} from '@ledger-lens/contracts';
import { firstValueFrom } from 'rxjs';
import { describeError, toApiError, type ErrorCopy } from '../../core/api/api-error';
import { BankLogo } from '../../shared/bank-logo/bank-logo';
import { Skeleton } from '../../shared/states/skeleton';
import { StateCard } from '../../shared/states/state-card';
import { StatusChip } from '../../shared/status-chip/status-chip';
import { TokenField } from './token-field';

interface Promise_ {
  icon: string;
  title: string;
  body: string;
}

const REDIRECT_PROMISES: readonly Promise_[] = [
  {
    icon: 'visibility',
    title: 'What we’ll see',
    body: 'Your account names and masked numbers, balances, and up to 13 months of transactions. Nothing else.',
  },
  {
    icon: 'schedule',
    title: 'For how long',
    body: 'Until the bank’s consent ends, usually 90 days. We remind you 14 days before and reconnecting takes one click.',
  },
  {
    icon: 'block',
    title: 'What we won’t do',
    body: 'Move money. A payment only happens when you start one here and approve it in your bank.',
  },
  {
    icon: 'verified_user',
    title: 'Your control',
    body: 'Revoke access any time in Connections. That also deletes everything we cached. We never see your bank login.',
  },
];

const TOKEN_PROMISES: readonly Promise_[] = [
  {
    icon: 'visibility',
    title: 'What we’ll see',
    body: 'Your cards, jars and balances, and your statement history. Nothing else.',
  },
  {
    icon: 'all_inclusive',
    title: 'For how long',
    body: 'Until you revoke the token at the bank. It has no expiry date, so it is kept encrypted on this machine only.',
  },
  {
    icon: 'block',
    title: 'What we won’t do',
    body: 'Move money. The token is read-only, and payments are not possible with it.',
  },
  {
    icon: 'speed',
    title: 'The one-minute rule',
    body: 'The bank allows one statement request per minute, so balances show at once and history fills in over a few minutes.',
  },
];

/** The "what we'll access and for how long" step, shown before leaving for the bank. */
@Component({
  selector: 'll-connect-review',
  imports: [
    BankLogo,
    MatButton,
    MatIcon,
    MatProgressSpinner,
    RouterLink,
    Skeleton,
    StateCard,
    StatusChip,
    TokenField,
  ],
  template: `
    <a routerLink="/connect" class="mb-4 inline-flex items-center gap-1 text-sm">
      <mat-icon class="!size-5 !text-xl">arrow_back</mat-icon>
      Choose a different bank
    </a>

    @if (institutions.status() === 'loading') {
      <ll-skeleton height="14rem" />
    } @else if (!bank()) {
      <ll-state
        icon="search_off"
        title="That bank isn’t available"
        message="It may have been removed, or the link is out of date."
        role="status"
      >
        <a mat-flat-button routerLink="/connect">Choose a bank</a>
      </ll-state>
    } @else {
      @if (bank(); as selected) {
        <article class="max-w-3xl" aria-labelledby="review-title">
          <header class="flex items-center gap-4">
            <ll-bank-logo [src]="selected.logoUrl" [name]="selected.name" [size]="56" />
            <div>
              <h1 id="review-title" class="text-3xl font-semibold tracking-tight">
                {{ reconnect() ? 'Reconnect' : 'Connect' }} {{ selected.name }}
              </h1>
              <p class="text-on-surface-variant">
                {{ selected.country }} · {{ selected.currencies.join(', ') }}
              </p>
            </div>
          </header>

          @if (selected.health === 'degraded') {
            <p
              class="mt-4 flex items-start gap-2 rounded-2xl bg-warning-container p-4 text-on-warning-container"
              role="note"
            >
              <mat-icon class="shrink-0">warning</mat-icon>
              <span
                >This bank is reporting problems, so connecting will most likely fail. That makes it
                a good way to see the outage state.</span
              >
            </p>
          }

          <section class="mt-6 grid gap-4 md:grid-cols-2" aria-label="What happens next">
            @for (item of promises(); track item.title) {
              <div
                class="flex gap-3 rounded-2xl border border-outline-variant bg-surface-container-low p-4"
              >
                <span
                  class="grid size-10 shrink-0 place-items-center rounded-full bg-primary-container text-on-primary-container"
                >
                  <mat-icon>{{ item.icon }}</mat-icon>
                </span>
                <div>
                  <h2 class="font-semibold">{{ item.title }}</h2>
                  <p class="text-sm text-on-surface-variant">{{ item.body }}</p>
                </div>
              </div>
            }
          </section>

          @if (selected.mode === 'mock') {
            <p class="mt-4 flex items-start gap-2 text-sm text-on-surface-variant">
              <mat-icon class="!size-5 !text-xl">info</mat-icon>
              <span
                >You’ll land on a simulated bank page where you pick who you’re signing in as.
                Nothing real is involved.</span
              >
            </p>
          }

          @if (selected.mode === 'live') {
            <p
              class="mt-4 flex items-start gap-2 rounded-2xl bg-warning-container p-4 text-on-warning-container"
              role="note"
              data-testid="live-note"
            >
              <mat-icon class="shrink-0" aria-hidden="true">shield</mat-icon>
              <span
                ><strong>This is a real bank.</strong> Your own accounts are read from this machine
                and kept encrypted here. {{ selected.name }}’s terms limit this API to personal and
                family use, so don’t host this app for other people.</span
              >
            </p>
          }

          @if (failure(); as copy) {
            <ll-state
              class="mt-6"
              [icon]="copy.icon"
              [title]="copy.title"
              [message]="copy.message"
              tone="error"
              role="alert"
            />
          }

          @if (selected.connectMethod === 'token' && selected.tokenHelp; as help) {
            <ll-token-field
              [bankName]="selected.name"
              [help]="help"
              [busy]="busy()"
              [error]="tokenError()"
              (submitted)="connectWithToken(selected, $event)"
            >
              @if (busy()) {
                <mat-spinner diameter="20" class="mr-2 inline-block" aria-hidden="true" />
              }
              Connect {{ selected.name }}
            </ll-token-field>
            <div class="mt-4"><a mat-button routerLink="/connect">Cancel</a></div>
          } @else {
            <div class="mt-6 flex flex-wrap items-center gap-3">
              <button
                mat-flat-button
                type="button"
                class="!h-12"
                [disabled]="busy()"
                data-testid="continue-to-bank"
                (click)="continueToBank(selected)"
              >
                @if (busy()) {
                  <mat-spinner diameter="20" class="mr-2 inline-block" aria-hidden="true" />
                }
                Continue to {{ selected.name }}
              </button>
              <a mat-button routerLink="/connect">Cancel</a>
              <ll-status-chip tone="info" icon="lock"
                >Redirects to your bank, never an iframe</ll-status-chip
              >
            </div>
          }
        </article>
      }
    }
  `,
})
export class ConnectReview {
  private readonly http = inject(HttpClient);
  private readonly document = inject(DOCUMENT);
  private readonly router = inject(Router);

  /** Route param (`/connect/review/:institutionId`), bound by `withComponentInputBinding`. */
  readonly institutionId = input.required<string>();
  /** Query param set by the Reconnect buttons: the connection to renew instead of creating a second one. */
  readonly reconnect = input<string | undefined>(undefined);

  protected readonly institutions = httpResource<Institution[]>(() => '/api/institutions', {
    defaultValue: [],
    parse: (raw) => InstitutionList.parse(raw).items,
  });
  protected readonly bank = computed(() =>
    this.institutions.value().find((i) => i.id === this.institutionId()),
  );

  protected readonly busy = signal(false);
  protected readonly failure = signal<ErrorCopy | null>(null);
  protected readonly tokenError = signal<string | null>(null);

  protected readonly promises = computed<readonly Promise_[]>(() =>
    this.bank()?.connectMethod === 'token' ? TOKEN_PROMISES : REDIRECT_PROMISES,
  );

  protected async connectWithToken(bank: Institution, token: string): Promise<void> {
    this.busy.set(true);
    this.failure.set(null);
    this.tokenError.set(null);
    try {
      const response = ConnectWithTokenResponse.parse(
        await firstValueFrom(
          this.http.post('/api/connections/token', {
            institutionId: bank.id,
            token,
            ...(this.reconnect() ? { reconnectConnectionId: this.reconnect() } : {}),
          }),
        ),
      );
      await this.router.navigate(['/connect/result'], {
        queryParams: { status: 'success', connection: response.connectionId },
      });
    } catch (error) {
      if (toApiError(error).code === 'validation_failed') {
        this.tokenError.set(
          `${bank.name} did not accept this token. Check that you copied all of it, or issue a new one.`,
        );
      } else {
        this.failure.set(describeError(error));
      }
      this.busy.set(false);
    }
  }

  protected async continueToBank(bank: Institution): Promise<void> {
    this.busy.set(true);
    this.failure.set(null);
    try {
      const response = CreateConnectionResponse.parse(
        await firstValueFrom(
          this.http.post('/api/connections', {
            institutionId: bank.id,
            ...(this.reconnect() ? { reconnectConnectionId: this.reconnect() } : {}),
          }),
        ),
      );
      // A full-page redirect, never an iframe: the bank must be able to prove where the customer is signing in.
      this.document.defaultView?.location.assign(response.authUrl);
    } catch (error) {
      this.failure.set(describeError(error));
      this.busy.set(false);
    }
  }
}
