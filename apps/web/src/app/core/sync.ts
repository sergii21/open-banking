import { inject, Service } from '@angular/core';
import type { SyncState } from '@ledger-lens/contracts';
import { Api, ApiError } from './api';
import { countdown } from './format';
import { Live } from './live';
import { Toast } from './toast';

/** The things the person can ask the loader to do. Every answer is honest about monobank's one-read-a-minute limit. */
@Service()
export class SyncActions {
  private readonly api = inject(Api);
  private readonly live = inject(Live);
  private readonly toast = inject(Toast);

  async refresh(): Promise<void> {
    try {
      const state = await this.api.post<SyncState>('/api/sync/refresh');
      this.live.sync.set(state);
      if (state.balancesNextAt) {
        const wait = Date.parse(state.balancesNextAt) - Date.now();
        if (wait > 1000)
          this.toast.show(
            `Balances are fresh. monobank allows another read in ${countdown(wait)}.`,
          );
      }
    } catch (error) {
      if (error instanceof ApiError && error.code === 'refresh_cooldown') {
        this.toast.show('Just refreshed.');
      } else if (error instanceof ApiError && error.code === 'reauth_required') {
        this.toast.show('monobank no longer accepts your token. Open Settings to paste a new one.');
      } else {
        this.toast.show('Could not refresh. Try again in a moment.');
      }
    }
  }

  async loadEarlier(): Promise<void> {
    try {
      this.live.sync.set(await this.api.post<SyncState>('/api/sync/load-earlier'));
      this.toast.show('Loading one more month of history.');
    } catch {
      this.toast.show('Could not start that. Try again in a moment.');
    }
  }

  async prioritise(accountId: string): Promise<void> {
    try {
      this.live.sync.set(await this.api.post<SyncState>(`/api/accounts/${accountId}/prioritise`));
      this.toast.show('This card goes first.');
    } catch {
      this.toast.show('Could not move this card up.');
    }
  }
}
