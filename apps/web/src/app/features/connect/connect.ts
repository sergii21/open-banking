import { httpResource } from '@angular/common/http';
import { Component, computed, signal } from '@angular/core';
import { MatButton } from '@angular/material/button';
import { MatFormField, MatLabel, MatPrefix } from '@angular/material/form-field';
import { MatIcon } from '@angular/material/icon';
import { MatInput } from '@angular/material/input';
import { RouterLink } from '@angular/router';
import { InstitutionList, type Institution } from '@ledger-lens/contracts';
import { describeError } from '../../core/api/api-error';
import { BankLogo } from '../../shared/bank-logo/bank-logo';
import { StatusChip } from '../../shared/status-chip/status-chip';
import { Skeleton } from '../../shared/states/skeleton';
import { StateCard } from '../../shared/states/state-card';

const MODE_LABEL = { mock: 'Mock bank', sandbox: 'Sandbox', live: 'Live' } as const;

@Component({
  selector: 'll-connect',
  imports: [
    BankLogo,
    MatButton,
    MatFormField,
    MatIcon,
    MatInput,
    MatLabel,
    MatPrefix,
    RouterLink,
    Skeleton,
    StateCard,
    StatusChip,
  ],
  template: `
    <div class="@container">
      <header class="mb-6 max-w-2xl">
        <h1 class="text-3xl font-semibold tracking-tight">Connect a bank</h1>
        <p class="mt-2 text-on-surface-variant">
          Ledger Lens reads your accounts through Open Banking. You sign in and approve at your
          bank; we never see your bank login.
        </p>
      </header>

      <mat-form-field class="w-full max-w-md" subscriptSizing="dynamic">
        <mat-label>Search banks</mat-label>
        <mat-icon matPrefix class="ml-3 mr-1">search</mat-icon>
        <input
          matInput
          type="search"
          autocomplete="off"
          [value]="query()"
          (input)="query.set($any($event.target).value)"
        />
      </mat-form-field>

      <section class="mt-6" aria-label="Available banks">
        @switch (institutions.status()) {
          @case ('loading') {
            <ul role="list" class="grid gap-3 @2xl:grid-cols-2 @4xl:grid-cols-3" aria-hidden="true">
              @for (n of [1, 2, 3]; track n) {
                <li><ll-skeleton height="5.5rem" /></li>
              }
            </ul>
            <p class="sr-only" role="status">Loading banks…</p>
          }
          @case ('error') {
            <ll-state
              icon="cloud_off"
              [title]="failure().title"
              [message]="failure().message"
              tone="error"
              role="alert"
            >
              <button mat-flat-button type="button" (click)="institutions.reload()">
                Try again
              </button>
            </ll-state>
          }
          @default {
            @if (filtered().length === 0) {
              <ll-state
                icon="search_off"
                title="No banks match"
                message="Try a different name, or clear the search."
                role="status"
              >
                <button mat-stroked-button type="button" (click)="query.set('')">
                  Clear search
                </button>
              </ll-state>
            } @else {
              <ul
                role="list"
                class="grid gap-3 @2xl:grid-cols-2 @4xl:grid-cols-3"
                data-testid="institution-list"
              >
                @for (bank of filtered(); track bank.id) {
                  <li>
                    <a
                      [routerLink]="['/connect', 'review', bank.id]"
                      class="flex h-full items-center gap-4 rounded-2xl border border-outline-variant bg-surface-container-low p-4 no-underline transition-colors hover:bg-surface-container focus-visible:bg-surface-container"
                      [attr.data-testid]="'bank-' + bank.id"
                    >
                      <ll-bank-logo [src]="bank.logoUrl" [name]="bank.name" [size]="48" />
                      <span class="min-w-0 flex-1">
                        <span class="block truncate font-semibold text-on-surface">{{
                          bank.name
                        }}</span>
                        <span class="block text-sm text-on-surface-variant"
                          >{{ bank.country }} · {{ bank.currencies.join(', ') }}</span
                        >
                        <span class="mt-1 flex flex-wrap gap-1">
                          <ll-status-chip tone="info">{{ modeLabel(bank) }}</ll-status-chip>
                          @if (bank.health === 'degraded') {
                            <ll-status-chip tone="warning" icon="warning"
                              >Reporting problems</ll-status-chip
                            >
                          }
                        </span>
                      </span>
                      <mat-icon class="text-on-surface-variant">chevron_right</mat-icon>
                    </a>
                  </li>
                }
              </ul>
            }
          }
        }
      </section>
    </div>
  `,
})
export class Connect {
  protected readonly institutions = httpResource<Institution[]>(() => '/api/institutions', {
    defaultValue: [],
    parse: (raw) => InstitutionList.parse(raw).items,
  });

  protected readonly query = signal('');
  protected readonly filtered = computed(() => {
    const needle = this.query().trim().toLowerCase();
    return this.institutions
      .value()
      .filter((bank) => !needle || bank.name.toLowerCase().includes(needle));
  });
  protected readonly failure = computed(() => describeError(this.institutions.error()));

  protected modeLabel(bank: Institution): string {
    return MODE_LABEL[bank.mode];
  }
}
