import { categorise } from '../../domain/categoriser';
import type { AccountWithConnection, ConnectionRecord, NewTransaction } from '../../db/repos';
import { AppError, notFound } from '../../errors';
import type { ProviderTransaction } from '../../providers/port';
import type { CoreContext } from '../../types';
import type { ConnectionAccess } from '../connections/access';

const DAY_MS = 86_400_000;
/** Re-read this much recent history on refresh so late-posted items and pending→booked changes are caught. */
const REFRESH_OVERLAP_DAYS = 14;

/**
 * Brings cached data in line with the bank. Reads go to this cache, never to the bank: PSD2 caps unattended access, so a
 * provider is only called on connect (user present) and on an explicit Refresh.
 */
export class SyncService {
  private readonly refreshing = new Set<string>();

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

  /** Stores one account's transactions; returns how many booked rows were new. */
  private storeTransactions(accountId: string, rows: readonly ProviderTransaction[]): number {
    const booked = rows.filter((row) => row.status === 'booked').map((row) => this.toNew(row));
    const pending = rows.filter((row) => row.status === 'pending').map((row) => this.toNew(row));
    const inserted = this.core.repos.transactions.upsertBooked(accountId, booked);
    this.core.repos.transactions.replacePending(accountId, pending);
    return inserted;
  }

  /** First sync after consent: every account, its balance, and ~13 months of transactions. */
  async initialSync(connection: ConnectionRecord): Promise<void> {
    await this.access.withTokens(connection, async (tokens, provider, call) => {
      const accounts = await provider.fetchAccounts(tokens, call);
      const now = this.core.clock.now();
      const nowIso = now.toISOString();
      const window = { from: this.historyStart(), to: this.isoDate(now) };

      const keep: string[] = [];
      for (const account of accounts) {
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
        const rows = await provider.fetchTransactions(
          tokens,
          { providerAccountId: account.providerAccountId, currency: account.currency },
          window,
          call,
        );
        this.storeTransactions(stored.id, rows);
      }
      this.core.repos.accounts.deleteMissing(connection.id, keep);
      this.core.repos.connections.update(connection.id, { lastRefreshedAt: nowIso }, nowIso);
    });
  }

  /** User-initiated refresh of one account: consent info, balance, and recent transactions. */
  async refreshAccount(
    sessionId: string,
    accountId: string,
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
          const from =
            overlapStart && overlapStart > this.historyStart() ? overlapStart : this.historyStart();
          const rows = await provider.fetchTransactions(
            tokens,
            ref,
            { from, to: this.isoDate(now) },
            call,
          );

          const nowIso = now.toISOString();
          return this.core.db.transaction(() => {
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
            const inserted = this.storeTransactions(account.id, rows);
            this.core.repos.connections.update(
              connection.id,
              {
                consentExpiresAt: consent.expiresAt,
                permissions: consent.permissions,
                lastRefreshedAt: nowIso,
              },
              nowIso,
            );
            return inserted;
          });
        },
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
