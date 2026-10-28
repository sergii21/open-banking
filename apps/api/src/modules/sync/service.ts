import { categorise } from '../../domain/categoriser';
import { planWindows } from '../../domain/sync-plan';
import type {
  AccountWithConnection,
  ConnectionRecord,
  NewTransaction,
  SyncJobRecord,
} from '../../db/repos';
import { AppError, notFound } from '../../errors';
import type { ProviderLimits, ProviderTransaction } from '../../providers/port';
import type { CoreContext } from '../../types';
import type { ConnectionAccess } from '../connections/access';

const DAY_MS = 86_400_000;
/** Re-read this much recent history on refresh so late-posted items and pending→booked changes are caught. */
const REFRESH_OVERLAP_DAYS = 14;
const MAX_JOB_ATTEMPTS = 3;
/** Background steps that fail are retried no sooner than this. */
const RETRY_AFTER_MS = 61_000;
/** Errors after which waiting will not help: the customer has to sign in or issue a token again. */
const CONNECTION_LOST = new Set([
  'reauth_required',
  'consent_expired',
  'consent_revoked',
  'connection_not_active',
]);

/**
 * Brings cached data in line with the bank. Reads go to this cache, never to the bank: PSD2 caps unattended access, so a
 * provider is only called on connect (user present), on an explicit Refresh and, for banks that cap how fast data may be
 * read, from a paced background queue that loads history one request at a time.
 */
export class SyncService {
  private readonly refreshing = new Set<string>();
  /** Earliest moment each paced connection may be read again. In memory: after a restart the bank's own 429 re-arms it. */
  private readonly gate = new Map<string, number>();
  private readonly working = new Set<string>();

  constructor(
    private readonly core: CoreContext,
    private readonly access: ConnectionAccess,
  ) {}

  private isoDate(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  private historyStart(): string {
    const now = this.core.clock.now();
    return this.isoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 13, 1)));
  }

  private toNew(row: ProviderTransaction): NewTransaction {
    return {
      providerTxnId: row.providerTxnId,
      bookedAt: row.bookedAt,
      amountMinor: row.amount.amountMinor,
      currency: row.amount.currency,
      description: row.description,
      counterparty: row.counterparty,
      category: categorise({
        description: row.description,
        counterparty: row.counterparty,
        amountMinor: row.amount.amountMinor,
        providerCategory: row.providerCategory,
      }),
    };
  }

  /**
   * Stores one account's transactions; returns how many booked rows were new. The pending set is only replaced when the
   * rows cover today: an older window has no pending items and must not wipe the ones already stored.
   */
  private storeTransactions(
    accountId: string,
    rows: readonly ProviderTransaction[],
    coversToday = true,
  ): number {
    const booked = rows.filter((row) => row.status === 'booked').map((row) => this.toNew(row));
    const pending = rows.filter((row) => row.status === 'pending').map((row) => this.toNew(row));
    const inserted = this.core.repos.transactions.upsertBooked(accountId, booked);
    if (coversToday) this.core.repos.transactions.replacePending(accountId, pending);
    return inserted;
  }

  /** A response that hit the provider's row cap may have cut the window short: queue the older rest of it. */
  private enqueueRemainder(
    connectionId: string,
    accountId: string,
    window: { from: string; to: string; seq: number },
    rows: readonly ProviderTransaction[],
    limits: ProviderLimits | undefined,
  ): void {
    if (!limits || rows.length < limits.maxItemsPerCall) return;
    const oldest = rows.reduce(
      (min, row) => (row.bookedAt < min ? row.bookedAt : min),
      rows[0].bookedAt,
    );
    const oldestDate = oldest.slice(0, 10);
    // Only when it narrows the window: a single day with more rows than the cap cannot be split any further.
    if (oldestDate > window.from && oldestDate < window.to) {
      this.core.repos.syncJobs.enqueue(
        { connectionId, accountId, from: window.from, to: oldestDate, seq: window.seq },
        this.core.clock.now().toISOString(),
      );
    }
  }

  /**
   * First sync after consent: every account and balance, then the transactions. Providers without read limits get
   * ~13 months right away; providers with limits get their history queued and loaded in the background.
   */
  async initialSync(connection: ConnectionRecord, psuIp?: string): Promise<void> {
    await this.access.withTokens(
      connection,
      async (tokens, provider, call) => {
        const accounts = await provider.fetchAccounts(tokens, call);
        const now = this.core.clock.now();
        const nowIso = now.toISOString();
        const limits = provider.limits;
        const window = { from: this.historyStart(), to: this.isoDate(now) };
        const windows = limits
          ? planWindows(this.isoDate(now), limits.historyMonths, limits.maxWindowDays)
          : [];
        if (limits) {
          this.core.repos.syncJobs.cancelPending(connection.id, 'superseded', nowIso);
          this.core.repos.syncJobs.purgeFinished(connection.id);
        }

        const keep: string[] = [];
        for (const [accountIndex, account] of accounts.entries()) {
          const stored = this.core.repos.accounts.upsert(connection.id, {
            providerAccountId: account.providerAccountId,
            name: account.name,
            type: account.type,
            currency: account.currency,
            maskedIdentifier: account.maskedIdentifier,
            balanceMinor: account.balance.amountMinor,
            availableMinor: account.availableBalance?.amountMinor ?? null,
            balanceAt: account.at,
            now: nowIso,
          });
          keep.push(account.providerAccountId);

          if (limits) {
            for (const [index, slice] of windows.entries()) {
              this.core.repos.syncJobs.enqueue(
                {
                  connectionId: connection.id,
                  accountId: stored.id,
                  ...slice,
                  seq: index * 1000 + accountIndex,
                },
                nowIso,
              );
            }
          } else {
            const rows = await provider.fetchTransactions(
              tokens,
              { providerAccountId: account.providerAccountId, currency: account.currency },
              window,
              call,
            );
            this.storeTransactions(stored.id, rows);
          }
        }
        this.core.repos.accounts.deleteMissing(connection.id, keep);
        this.core.repos.connections.update(connection.id, { lastRefreshedAt: nowIso }, nowIso);
      },
      { psuIp },
    );
  }

  // ------------------------------------------------------------------------------ paced background loading

  /** One step of the background queue for every connection whose rate gate is open. Returns how many steps ran. */
  async runDue(): Promise<number> {
    const nowMs = this.core.clock.now().getTime();
    let ran = 0;
    for (const connectionId of this.core.repos.syncJobs.connectionsWithPending()) {
      if ((this.gate.get(connectionId) ?? 0) > nowMs || this.working.has(connectionId)) continue;
      this.working.add(connectionId);
      try {
        if (await this.runNext(connectionId)) ran += 1;
      } finally {
        this.working.delete(connectionId);
      }
    }
    return ran;
  }

  private async runNext(connectionId: string): Promise<boolean> {
    const { repos } = this.core;
    const now = this.core.clock.now();
    const nowIso = now.toISOString();

    const connection = repos.connections.findById(connectionId);
    if (connection?.status !== 'active') {
      repos.syncJobs.cancelPending(connectionId, 'connection_not_active', nowIso);
      return false;
    }
    const job = repos.syncJobs.next(connectionId);
    if (!job) {
      repos.syncJobs.purgeFinished(connectionId);
      return false;
    }
    const account = repos.accounts.findById(job.accountId);
    if (!account) {
      repos.syncJobs.markDone(job.id, nowIso);
      return true;
    }

    try {
      const { rows, limits } = await this.access.withTokens(
        connection,
        async (tokens, provider, call) => ({
          limits: provider.limits,
          rows: await provider.fetchTransactions(
            tokens,
            { providerAccountId: account.providerAccountId, currency: account.currency },
            { from: job.from, to: job.to },
            call,
          ),
        }),
      );
      this.storeTransactions(account.id, rows, job.to >= this.isoDate(now));
      this.enqueueRemainder(connectionId, account.id, job, rows, limits);
      repos.syncJobs.markDone(job.id, nowIso);
      repos.connections.update(connectionId, { lastRefreshedAt: nowIso }, nowIso);
      this.gate.set(connectionId, now.getTime() + (limits?.minIntervalMs ?? 0));
    } catch (error) {
      return this.handleStepFailure(connectionId, job, error, now);
    }
    if (!repos.syncJobs.next(connectionId)) repos.syncJobs.purgeFinished(connectionId);
    this.access.notify(connectionId);
    return true;
  }

  private handleStepFailure(
    connectionId: string,
    job: SyncJobRecord,
    error: unknown,
    now: Date,
  ): boolean {
    const nowIso = now.toISOString();
    if (error instanceof AppError) {
      if (error.code === 'rate_limited') {
        // The bank is the authority on its own limit; wait as long as it says and try the same step again.
        this.gate.set(connectionId, now.getTime() + (error.retryAfterSeconds ?? 61) * 1000);
        return false;
      }
      if (CONNECTION_LOST.has(error.code)) {
        this.core.repos.syncJobs.cancelPending(connectionId, error.code, nowIso);
        this.access.notify(connectionId);
        return false;
      }
    }
    this.core.log.warn(
      { connectionId, code: error instanceof AppError ? error.code : 'unexpected' },
      'background sync step failed',
    );
    this.core.repos.syncJobs.recordFailure(
      job.id,
      error instanceof Error ? error.message.slice(0, 200) : 'unknown error',
      MAX_JOB_ATTEMPTS,
      nowIso,
    );
    this.gate.set(connectionId, now.getTime() + RETRY_AFTER_MS);
    return true;
  }

  // ------------------------------------------------------------------------------ user-initiated refresh

  /** User-initiated refresh of one account: consent info, balance, and recent transactions. */
  async refreshAccount(
    sessionId: string,
    accountId: string,
    psuIp?: string,
  ): Promise<{ account: AccountWithConnection; newTransactions: number }> {
    const account = this.core.repos.accounts.findForSession(sessionId, accountId);
    if (!account) throw notFound('Account');
    const connection = this.core.repos.connections.findForSession(sessionId, account.connectionId);
    if (!connection) throw notFound('Connection');
    this.access.assertUsable(connection);

    const now = this.core.clock.now();
    const sinceLast = (now.getTime() - Date.parse(account.lastRefreshedAt)) / 1000;
    const cooldown = this.core.config.refreshCooldownSeconds;
    if (sinceLast < cooldown) {
      throw new AppError('refresh_cooldown', 429, 'This account was refreshed moments ago.', {
        retryAfterSeconds: Math.ceil(cooldown - sinceLast),
      });
    }
    const limits = this.access.limitsFor(connection);
    const gateWait = (this.gate.get(connection.id) ?? 0) - now.getTime();
    if (limits && gateWait > 0) {
      throw new AppError(
        'rate_limited',
        429,
        'The bank allows one transaction read per minute and one is already under way. Try again shortly.',
        { retryAfterSeconds: Math.ceil(gateWait / 1000) },
      );
    }
    if (this.refreshing.has(account.id)) {
      throw new AppError(
        'refresh_cooldown',
        429,
        'A refresh is already running for this account.',
        {
          retryAfterSeconds: 5,
        },
      );
    }

    this.refreshing.add(account.id);
    try {
      const newTransactions = await this.access.withTokens(
        connection,
        async (tokens, provider, call) => {
          const ref = { providerAccountId: account.providerAccountId, currency: account.currency };
          const consent = await provider.fetchConsent(tokens, call);
          const balance = await provider.fetchBalance(tokens, ref, call);

          const latest = this.core.repos.transactions.latestBookedAt(account.id);
          const overlapStart = latest
            ? this.isoDate(new Date(Date.parse(latest) - REFRESH_OVERLAP_DAYS * DAY_MS))
            : null;
          const earliest = provider.limits
            ? this.isoDate(new Date(now.getTime() - (provider.limits.maxWindowDays - 1) * DAY_MS))
            : this.historyStart();
          const from = overlapStart && overlapStart > earliest ? overlapStart : earliest;
          const window = { from, to: this.isoDate(now) };
          const rows = await provider.fetchTransactions(tokens, ref, window, call);

          const nowIso = now.toISOString();
          const inserted = this.core.db.transaction(() => {
            this.core.repos.accounts.upsert(connection.id, {
              providerAccountId: account.providerAccountId,
              name: account.name,
              type: account.type,
              currency: account.currency,
              maskedIdentifier: account.maskedIdentifier,
              balanceMinor: balance.balance.amountMinor,
              availableMinor: balance.availableBalance?.amountMinor ?? null,
              balanceAt: balance.at,
              now: nowIso,
            });
            const count = this.storeTransactions(account.id, rows);
            this.core.repos.connections.update(
              connection.id,
              {
                consentExpiresAt: consent.expiresAt,
                permissions: consent.permissions,
                lastRefreshedAt: nowIso,
              },
              nowIso,
            );
            return count;
          });
          if (provider.limits) {
            this.gate.set(connection.id, now.getTime() + provider.limits.minIntervalMs);
            this.enqueueRemainder(
              connection.id,
              account.id,
              { ...window, seq: 0 },
              rows,
              provider.limits,
            );
          }
          return inserted;
        },
        { psuIp },
      );
      this.access.notify(connection.id);
      const refreshed = this.core.repos.accounts.findForSession(sessionId, accountId);
      if (!refreshed) throw notFound('Account');
      return { account: refreshed, newTransactions };
    } finally {
      this.refreshing.delete(account.id);
    }
  }
}
