import { RateTable } from '../../domain/rates';
import type { ConnectionRecord } from '../../db/repos';
import type { RatePair } from '../../providers/port';
import type { ProviderRegistry } from '../../providers/registry';
import type { CoreContext } from '../../types';

/** monobank updates its rates at most every five minutes, so there is no point in asking more often. */
const REFRESH_AFTER_MS = 5 * 60_000;
const RETRY_AFTER_FAILURE_MS = 60_000;
/** The first Home after connecting waits this long for rates before showing amounts it cannot convert yet. */
const FIRST_WAIT_MS = 2_500;

/**
 * Exchange rates for valuing foreign balances in hryvnias. Served from memory, refreshed in the background, persisted so the
 * last known rates survive a restart and a failed call (the screens say when the rates are older than they should be).
 */
export class RatesService {
  private table: RateTable | null = null;
  private lastAttemptAt = 0;
  private failing = false;
  private inflight: Promise<void> | null = null;
  /** Called when a refresh brought rates a screen has not seen yet. */
  onUpdate: ((sessionId: string) => void) | null = null;

  constructor(
    private readonly core: CoreContext,
    private readonly providers: ProviderRegistry,
  ) {}

  private load(): void {
    if (this.table) return;
    const stored = this.core.repos.rates.get();
    if (!stored) return;
    try {
      this.table = new RateTable(JSON.parse(stored.payload) as RatePair[]);
    } catch {
      this.table = null;
    }
  }

  private due(): boolean {
    const gap = this.failing ? RETRY_AFTER_FAILURE_MS : REFRESH_AFTER_MS;
    return this.core.clock.now().getTime() - this.lastAttemptAt >= gap;
  }

  private refresh(connection: ConnectionRecord): Promise<void> {
    this.inflight ??= (async () => {
      this.lastAttemptAt = this.core.clock.now().getTime();
      const hadRates = this.table !== null && !this.table.isEmpty();
      for (const source of this.providers.ratesFrom(connection.provider)) {
        try {
          const pairs = await source.fetchRates({
            sessionId: connection.sessionId,
            connectionId: connection.id,
          });
          if (pairs.length === 0) continue;
          this.table = new RateTable(pairs);
          this.failing = false;
          this.core.repos.rates.put(JSON.stringify(pairs), this.core.clock.now().toISOString());
          if (!hadRates) this.onUpdate?.(connection.sessionId);
          return;
        } catch {
          // Try the next source; if none works we keep the last known rates and say so.
        }
      }
      this.failing = true;
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Starts a refresh without waiting for it (used right after connecting, so Home finds rates ready). */
  warm(connection: ConnectionRecord): void {
    this.load();
    if (!this.table || this.due()) void this.refresh(connection);
  }

  async get(connection: ConnectionRecord): Promise<{ table: RateTable; stale: boolean }> {
    this.load();
    if (!this.table || this.table.isEmpty()) {
      await Promise.race([
        this.refresh(connection),
        new Promise<void>((resolve) => setTimeout(resolve, FIRST_WAIT_MS).unref()),
      ]);
    } else if (this.due()) {
      void this.refresh(connection);
    }
    return { table: this.table ?? new RateTable([]), stale: this.failing };
  }
}
