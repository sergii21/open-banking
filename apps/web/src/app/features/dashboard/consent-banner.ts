import { Component, computed, input } from '@angular/core';
import { MatButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { RouterLink } from '@angular/router';
import type { Connection } from '@ledger-lens/contracts';

interface BannerView {
  icon: string;
  title: string;
  message: string;
  action: string;
  classes: string;
  role: 'alert' | 'status';
}

const WARNING = 'bg-warning-container text-on-warning-container';
const ERROR = 'bg-error-container text-on-error-container';

/** Tells the person, in plain words, when a bank connection needs attention, with the fix one click away. */
@Component({
  selector: 'll-consent-banner',
  imports: [MatButton, MatIcon, RouterLink],
  template: `
    @if (view(); as banner) {
      <div
        class="flex flex-wrap items-center gap-3 rounded-2xl p-4"
        [class]="banner.classes"
        [attr.role]="banner.role"
        data-testid="consent-banner"
      >
        <mat-icon aria-hidden="true">{{ banner.icon }}</mat-icon>
        <div class="min-w-0 flex-1">
          <p class="font-semibold">{{ banner.title }}</p>
          <p class="text-sm">{{ banner.message }}</p>
        </div>
        <a
          mat-flat-button
          [routerLink]="['/connect', 'review', connection().institutionId]"
          [queryParams]="{ reconnect: connection().id }"
          data-testid="reconnect"
        >
          {{ banner.action }}
        </a>
      </div>
    }
  `,
  host: { class: 'block' },
})
export class ConsentBanner {
  readonly connection = input.required<Connection>();

  protected readonly view = computed<BannerView | null>(() => {
    const c = this.connection();
    const name = c.institutionName;
    switch (c.status) {
      case 'needs_reauth':
        if (c.provider === 'monobank') {
          return {
            icon: 'key_off',
            title: `${name} no longer accepts your token`,
            message:
              'The token was replaced or revoked at api.monobank.ua. Your data is still here but won’t update until you paste a new token.',
            action: 'Add a new token',
            classes: ERROR,
            role: 'alert',
          };
        }
        return {
          icon: 'lock_reset',
          title: `${name} needs you to sign in again`,
          message:
            'The bank no longer accepts our access, for example because consent was withdrawn. Your data is still here but won’t update until you reconnect.',
          action: 'Reconnect',
          classes: ERROR,
          role: 'alert',
        };
      case 'revoked':
        return {
          icon: 'link_off',
          title: `Access to ${name} was revoked`,
          message:
            'Consent was withdrawn at the bank. Reconnect if you want Ledger Lens to read it again.',
          action: 'Reconnect',
          classes: ERROR,
          role: 'alert',
        };
      case 'expired':
        return {
          icon: 'event_busy',
          title: `Access to ${name} has ended`,
          message:
            'Bank consent only lasts a limited time. Reconnect to keep your accounts up to date.',
          action: 'Reconnect',
          classes: ERROR,
          role: 'alert',
        };
      case 'error':
        return {
          icon: 'error',
          title: `Something went wrong with ${name}`,
          message:
            'Reconnect to start fresh. Your cached data stays until you remove the connection.',
          action: 'Reconnect',
          classes: ERROR,
          role: 'alert',
        };
      case 'active':
        if (c.consentState === 'expiring_soon') {
          const days = c.consentDaysRemaining ?? 0;
          return {
            icon: 'event_upcoming',
            title: `Access to ${name} ends in ${days} ${days === 1 ? 'day' : 'days'}`,
            message:
              'Banks only grant access for a limited time. Renew it now to avoid a gap in your data.',
            action: 'Renew access',
            classes: WARNING,
            role: 'status',
          };
        }
        return null;
      default:
        return null;
    }
  });
}
