import { DOCUMENT } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { MatButton } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIcon } from '@angular/material/icon';
import { MatSnackBar } from '@angular/material/snack-bar';
import { RouterLink } from '@angular/router';
import type { Connection, Permission } from '@ledger-lens/contracts';
import { firstValueFrom } from 'rxjs';
import { describeError, toApiError } from '../../core/api/api-error';
import { Data } from '../../core/data/data';
import { SessionService } from '../../core/session/session';
import { BankLogo } from '../../shared/bank-logo/bank-logo';
import { confirm } from '../../shared/confirm-dialog/confirm-dialog';
import { formatDate } from '../../shared/format';
import { RelativeTime } from '../../shared/relative-time/relative-time';
import { Skeleton } from '../../shared/states/skeleton';
import { StateCard } from '../../shared/states/state-card';
import { StatusChip, type Tone } from '../../shared/status-chip/status-chip';
import { ConsentBanner } from '../dashboard/consent-banner';

const PERMISSION_LABEL: Record<Permission, string> = {
  accounts: 'Account details',
  balances: 'Balances',
  transactions: 'Transactions',
};

interface StatusView {
  tone: Tone;
  icon: string;
  label: string;
}

@Component({
  selector: 'll-connections',
  imports: [
    BankLogo,
    ConsentBanner,
    MatButton,
    MatIcon,
    RelativeTime,
    RouterLink,
    Skeleton,
    StateCard,
    StatusChip,
  ],
  templateUrl: './connections.html',
})
export class Connections {
  protected readonly data = inject(Data);
  private readonly http = inject(HttpClient);
  private readonly dialog = inject(MatDialog);
  private readonly snackBar = inject(MatSnackBar);
  private readonly session = inject(SessionService);
  private readonly document = inject(DOCUMENT);

  protected readonly loading = computed(() => this.data.connections.status() === 'loading');
  protected readonly failure = computed(() => describeError(this.data.connections.error()));
  protected readonly busyId = signal<string | null>(null);
  protected readonly deletingAll = signal(false);

  protected permissionLabel(permission: Permission): string {
    return PERMISSION_LABEL[permission];
  }

  protected formatDate(iso: string): string {
    return formatDate(iso, 'long');
  }

  protected status(connection: Connection): StatusView {
    switch (connection.status) {
      case 'needs_reauth':
        return { tone: 'error', icon: 'lock_reset', label: 'Sign-in needed' };
      case 'revoked':
        return { tone: 'error', icon: 'link_off', label: 'Revoked' };
      case 'expired':
        return { tone: 'error', icon: 'event_busy', label: 'Expired' };
      case 'error':
        return { tone: 'error', icon: 'error', label: 'Error' };
      case 'pending':
        return { tone: 'neutral', icon: 'hourglass_empty', label: 'Pending' };
      default:
        return connection.consentState === 'expiring_soon'
          ? {
              tone: 'warning',
              icon: 'event_upcoming',
              label: `Ends in ${connection.consentDaysRemaining ?? 0} days`,
            }
          : { tone: 'success', icon: 'check_circle', label: 'Active' };
    }
  }

  protected consentLine(connection: Connection): string {
    if (!connection.consentExpiresAt) return 'The bank reports no end date';
    const date = this.formatDate(connection.consentExpiresAt);
    if (connection.consentState === 'expired' || connection.status === 'expired')
      return `Ended on ${date}`;
    const days = connection.consentDaysRemaining ?? 0;
    return `Ends on ${date} (${days} ${days === 1 ? 'day' : 'days'} left)`;
  }

  protected async remove(connection: Connection): Promise<void> {
    const ok = await confirm(this.dialog, {
      title: `Remove ${connection.institutionName}?`,
      message: `We’ll withdraw our access at the bank and delete every account and transaction we cached from it. You can connect it again later.`,
      confirmLabel: 'Remove and delete data',
      destructive: true,
    });
    if (!ok) return;
    this.busyId.set(connection.id);
    try {
      await firstValueFrom(this.http.delete(`/api/connections/${connection.id}`));
      this.data.reload();
      this.snackBar.open(`${connection.institutionName} removed and its data deleted.`, 'OK', {
        duration: 6000,
      });
    } catch (error) {
      this.snackBar.open(toApiError(error).message, 'OK', { duration: 8000 });
    } finally {
      this.busyId.set(null);
    }
  }

  protected async deleteEverything(): Promise<void> {
    const ok = await confirm(this.dialog, {
      title: 'Delete all my data?',
      message:
        'This withdraws access at every connected bank and erases all cached accounts, transactions and payments, plus this demo session. It cannot be undone.',
      confirmLabel: 'Delete everything',
      destructive: true,
    });
    if (!ok) return;
    this.deletingAll.set(true);
    try {
      await this.session.deleteEverything();
      // A full reload drops every in-memory cache and starts a clean session.
      this.document.defaultView?.location.assign('/');
    } catch (error) {
      this.snackBar.open(toApiError(error).message, 'OK', { duration: 8000 });
      this.deletingAll.set(false);
    }
  }
}
