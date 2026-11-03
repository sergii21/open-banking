import { Component, computed, inject, signal } from '@angular/core';
import { Api, ApiError } from '../../core/api';
import { ago, countdown } from '../../core/format';
import { Live } from '../../core/live';
import { Prefs, type ThemeChoice } from '../../core/prefs';
import { Session } from '../../core/session';
import { SyncActions } from '../../core/sync';
import { Ticker } from '../../core/ticker';
import { Toast } from '../../core/toast';
import { Ui } from '../../core/ui';
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

  protected readonly themes: { id: ThemeChoice; label: string }[] = [
    { id: 'system', label: 'System' },
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
  ];

  protected readonly replacing = signal(false);
  protected readonly newToken = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly confirming = signal(false);
  private confirmTimer: ReturnType<typeof setTimeout> | undefined;

  protected readonly lastSync = computed(() => {
    const at = this.session.connection()?.lastSyncAt;
    return at ? ago(Date.parse(at), this.ticker.now()) : 'not yet';
  });

  protected openLiveApi(): void {
    this.ui.settings.set(false);
    this.ui.liveApi.set(true);
  }

  protected async replace(): Promise<void> {
    if (!this.newToken().trim() || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.session.replaceToken(this.newToken());
      this.newToken.set('');
      this.replacing.set(false);
      this.toast.show('Token accepted. Your history is still here.');
    } catch (error) {
      this.error.set(
        error instanceof ApiError && error.code === 'rate_limited'
          ? `monobank allows one check a minute. Try again in ${countdown((error.retryAfterSeconds ?? 60) * 1000)}.`
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
  protected async leaveDemo(): Promise<void> {
    try {
      await this.session.disconnect();
      this.ui.settings.set(false);
    } catch {
      this.toast.show('Could not leave the demo. Try again.');
    }
  }

  protected async disconnect(): Promise<void> {
    if (!this.confirming()) {
      this.confirming.set(true);
      clearTimeout(this.confirmTimer);
      this.confirmTimer = setTimeout(() => this.confirming.set(false), 4000);
      return;
    }
    this.confirming.set(false);
    try {
      await this.session.disconnect();
      this.ui.settings.set(false);
      this.toast.show(
        'Disconnected. Everything read from the bank was deleted from this computer.',
        4500,
      );
    } catch {
      this.toast.show('Could not disconnect. Try again.');
    }
  }
}
