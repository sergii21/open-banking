import { HttpClient } from '@angular/common/http';
import { computed, inject, Service, signal } from '@angular/core';
import { SessionInfo, type ProviderMode } from '@ledger-lens/contracts';
import { firstValueFrom } from 'rxjs';
import { ApiError, toApiError } from '../api/api-error';

/**
 * The anonymous demo session. The BFF issues an HttpOnly cookie on first contact; the SPA never sees it, only the
 * descriptive info (which providers are enabled, whether demo controls are on, limits).
 */
@Service()
export class SessionService {
  private readonly http = inject(HttpClient);

  readonly info = signal<SessionInfo | null>(null);
  /** Set when the API could not be reached at startup; the shell shows a retry screen instead of the app. */
  readonly error = signal<ApiError | null>(null);

  readonly demoControls = computed(() => this.info()?.demoControls ?? false);
  readonly cooldownSeconds = computed(() => this.info()?.limits.refreshCooldownSeconds ?? 20);
  readonly maxPaymentMinor = computed(() => this.info()?.limits.maxPaymentMinor ?? 500_000);

  /** The most "real" mode among enabled providers, for the badge in the toolbar. */
  readonly mode = computed<ProviderMode>(() => {
    const modes = this.info()?.providers.map((p) => p.mode) ?? [];
    return modes.includes('live') ? 'live' : modes.includes('sandbox') ? 'sandbox' : 'mock';
  });

  async bootstrap(): Promise<void> {
    try {
      this.info.set(SessionInfo.parse(await firstValueFrom(this.http.get('/api/session'))));
      this.error.set(null);
    } catch (error) {
      this.error.set(toApiError(error));
    }
  }

  /** "Delete all my data": the BFF withdraws consents and erases the session. */
  async deleteEverything(): Promise<void> {
    await firstValueFrom(this.http.delete('/api/session'));
    this.info.set(null);
  }
}
