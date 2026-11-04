import { Component, computed, inject, signal } from '@angular/core';
import type { ConnectionInfo } from '@ledger-lens/contracts';
import { Api, ApiError } from '../../core/api';
import { ago, countdown } from '../../core/format';
import { Live } from '../../core/live';
import { Nav } from '../../core/nav';
import { Prefs, type ThemeChoice } from '../../core/prefs';
import { Session } from '../../core/session';
import { SyncActions } from '../../core/sync';
import { Ticker } from '../../core/ticker';
import { Toast } from '../../core/toast';
import { Ui } from '../../core/ui';
import { BANK_NAME } from '../../shared/banks';
import { Icon } from '../../shared/icon';
import { Sheet } from '../../shared/sheet';

@Component({
  selector: 'll-settings',
  imports: [Icon, Sheet],
  templateUrl: './settings.html',
})
export class Settings {
  private readonly api = inject(Api);
  protected readonly session = inject(Session);
  protected readonly prefs = inject(Prefs);
  protected readonly ui = inject(Ui);
  protected readonly live = inject(Live);
  protected readonly actions = inject(SyncActions);
  private readonly toast = inject(Toast);
  private readonly ticker = inject(Ticker);
  private readonly nav = inject(Nav);

  protected readonly themes: { id: ThemeChoice; label: string }[] = [
    { id: 'system', label: 'System' },
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
  ];

  /** The connection whose token is being replaced, and the connection waiting for a second press to be removed. */
  protected readonly replacing = signal<string | null>(null);
  protected readonly newToken = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly confirming = signal<string | null>(null);
  private confirmTimer: ReturnType<typeof setTimeout> | undefined;

  protected draftWise(): void {
    this.ui.settings.set(false);
    this.ui.wiseDraft.set(true);
  }

  protected readonly hasStatement = computed(() =>
    this.session.connections().some((c) => c.kind === 'file'),
  );

  protected lastSync(connection: ConnectionInfo): string {
    return connection.lastSyncAt
      ? ago(Date.parse(connection.lastSyncAt), this.ticker.now())
      : 'not yet';
  }

  protected bankName(connection: ConnectionInfo): string {
    return BANK_NAME[connection.bank];
  }

  protected openLiveApi(): void {
    this.ui.settings.set(false);
    this.ui.liveApi.set(true);
  }

  protected addBank(source?: string): void {
    this.ui.settings.set(false);
    void this.nav.go(source ? `/connect?source=${source}` : '/connect');
  }

  protected startReplacing(id: string): void {
    this.replacing.set(id);
    this.newToken.set('');
    this.error.set(null);
  }

  protected async replace(connection: ConnectionInfo): Promise<void> {
    if (!this.newToken().trim() || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.session.replaceToken(connection.id, this.newToken());
      this.newToken.set('');
      this.replacing.set(null);
      this.toast.show('Token accepted. Your history is still here.');
    } catch (error) {
      this.error.set(
        error instanceof ApiError && error.code === 'rate_limited'
          ? `${this.bankName(connection)} allows one check a minute. Try again in ${countdown((error.retryAfterSeconds ?? 60) * 1000)}.`
          : error instanceof ApiError
            ? (error.fields[0]?.message ?? error.message)
            : 'Something went wrong.',
      );
    } finally {
      this.busy.set(false);
    }
  }

  protected async copyDiagnostics(): Promise<void> {
    try {
      const { text } = await this.api.get<{ text: string }>('/api/diagnostics');
      await navigator.clipboard.writeText(text);
      this.toast.show('Diagnostics copied. They hold no token, names, merchants or amounts.', 4500);
    } catch {
      this.toast.show('Could not copy the diagnostics.');
    }
  }

  /** Leaving the demo is the normal first step: the same reset as disconnecting, without the warning (nothing here is yours). */
  protected async leaveDemo(connection: ConnectionInfo): Promise<void> {
    try {
      await this.session.disconnect(connection.id);
      this.ui.settings.set(false);
    } catch {
      this.toast.show('Could not leave the demo. Try again.');
    }
  }

  /** Removing a bank takes two presses; everything read from it is deleted here. */
  protected async disconnect(connection: ConnectionInfo): Promise<void> {
    if (this.confirming() !== connection.id) {
      this.confirming.set(connection.id);
      clearTimeout(this.confirmTimer);
      this.confirmTimer = setTimeout(() => this.confirming.set(null), 4000);
      return;
    }
    this.confirming.set(null);
    try {
      await this.session.disconnect(connection.id);
      this.ui.imported.set(null);
      if (!this.session.connected()) this.ui.settings.set(false);
      this.toast.show(
        connection.kind === 'file'
          ? 'Removed. The imported rows were deleted from this computer.'
          : 'Disconnected. Everything read from the bank was deleted from this computer.',
        4500,
      );
    } catch {
      this.toast.show('Could not disconnect. Try again.');
    }
  }
}
