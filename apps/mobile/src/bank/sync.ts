import type { Clock } from '@api/clock';
import { addDays, planWindows, type Calendar } from '@api/domain/calendar';
import { categorise } from '@api/domain/categoriser';
import { AppError } from '@api/errors';
import {
  TokenRejectedError,
  type CallContext,
  type ProviderAccount,
  type ProviderTransaction,
} from '@api/providers/port';
import type { Store, TransactionRow } from '../data/db';
import type { TokenVault } from '../platform/keychain';
import { DEMO_TOKEN, type Bank } from './provider';

const CTX: CallContext = { sessionId: 'phone', connectionId: null };
/** Balances are read again when they are this old and the app is open. */
const BALANCES_FRESH_MS = 5 * 60_000;
/** Rates change a few times a day. */
const RATES_FRESH_MS = 60 * 60_000;
/** The last days are read again on a refresh: a hold becomes booked, a late row arrives. */
const RECENT_DAYS = 3;

export type SyncStatus =
  | 'not-connected'
  | 'loading' // a read is on its way
  | 'waiting' // the bank's minute is running
  | 'up-to-date'
  | 'needs-token' // the bank no longer accepts the token
  | 'bank-down';

export interface SyncState {
  status: SyncStatus;
  demo: boolean;
  /** Statement reads done and planned: the history loads one read a minute. */
  windowsDone: number;
  windowsTotal: number;
  /** When the next read may go out, Unix milliseconds, while waiting. */
  nextAt: number | null;
  /** When balances were last read, Unix milliseconds. */
  balancesAt: number | null;
}

export const toRow = (accountId: string, t: ProviderTransaction, fop: boolean): TransactionRow => ({
  id: `${accountId}:${t.providerTxnId}`,
  accountId,
  ts: t.ts,
  status: t.status,
  amountMinor: t.amountMinor,
  currency: t.currency,
  description: t.description,
  counterparty: t.counterparty,
  comment: t.comment,
  mcc: t.mcc,
  category: categorise({
    description: t.description,
    counterparty: t.counterparty,
    comment: t.comment,
    amountMinor: t.amountMinor,
    mcc: t.mcc,
    fop,
  }),
});

/**
 * Reads the bank at the bank's pace, on the phone. Connecting is one read of the account list; after that statements
 * come one window a minute, the newest month of every card first. Each `step()` does at most one read and says how
 * long to wait before the next, so the screen that drives it decides when to stop (iOS pauses the app in the
 * background, and the queue simply goes on the next time it is opened).
 *
 * The same token on the person's computer shares monobank's limit: a 429 here just means "wait", never an error.
 */
export class Sync {
  private state: SyncState = {
    status: 'not-connected',
    demo: false,
    windowsDone: 0,
    windowsTotal: 0,
    nextAt: null,
    balancesAt: null,
  };
  private readonly listeners = new Set<(state: SyncState) => void>();

  constructor(
    private readonly bank: Bank,
    private readonly store: Store,
    private readonly vault: TokenVault,
    private readonly clock: Clock,
    private readonly calendar: Calendar,
  ) {}

  get current(): SyncState {
    return this.state;
  }

  subscribe(listener: (state: SyncState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<SyncState>): void {
    this.state = { ...this.state, ...patch, demo: this.bank.demo };
    for (const listener of this.listeners) listener(this.state);
  }

  private now(): number {
    return this.clock.now().getTime();
  }

  private async token(): Promise<string | null> {
    return this.bank.demo ? DEMO_TOKEN : this.vault.read();
  }

  private async time(key: string): Promise<number> {
    return Number((await this.store.meta(key)) ?? 0);
  }

  /** Picks up where the last run stopped. */
  async resume(): Promise<void> {
    const connected = (await this.store.meta('connected')) === (this.bank.demo ? 'demo' : 'live');
    if (!connected || (await this.token()) === null) {
      this.set({ status: 'not-connected' });
      return;
    }
    const counts = await this.store.windowCounts();
    this.set({
      status: (await this.store.meta('tokenRejected')) ? 'needs-token' : 'waiting',
      windowsDone: counts.done,
      windowsTotal: counts.total,
      nextAt: null,
      balancesAt: (await this.time('balancesAt')) || null,
    });
  }

  /**
   * Checks the token with one real read and keeps it only if the bank accepts it. Throws the adapter's `AppError`
   * with words for the person when it does not; the token is in none of them.
   */
  async connect(typedToken: string): Promise<void> {
    this.set({ status: 'loading' });
    let accounts: ProviderAccount[];
    try {
      const token = this.bank.demo ? DEMO_TOKEN : typedToken;
      const result = await this.bank.provider.connect({ token }, CTX);
      accounts = result.accounts;
      if (!this.bank.demo) await this.vault.save(result.tokens.accessToken);
    } catch (error) {
      this.set({ status: 'not-connected' });
      throw error;
    }
    const now = this.now();
    await this.store.clearBank();
    await this.store.replaceAccounts(accounts);
    await this.store.setMeta('connected', this.bank.demo ? 'demo' : 'live');
    await this.store.setMeta('balancesAt', String(now));
    await this.store.setMeta('infoAt', String(now));
    await this.planHistory(accounts);
    const counts = await this.store.windowCounts();
    this.set({
      status: 'waiting',
      windowsDone: counts.done,
      windowsTotal: counts.total,
      nextAt: null,
      balancesAt: now,
    });
  }

  /** The newest window of every card, then the one before of every card, and so on: jars hold no spending and are left out. */
  private async planHistory(accounts: readonly ProviderAccount[]): Promise<void> {
    const { historyMonths, maxWindowDays } = this.bank.provider.limits;
    const windows = planWindows(
      this.calendar.today(this.clock.now()),
      historyMonths,
      maxWindowDays,
    );
    const cards = accounts.filter((a) => a.kind === 'card');
    for (const [index, window] of windows.entries()) {
      for (const card of cards) {
        await this.store.addWindow(card.providerAccountId, window.from, window.to, index + 1);
      }
    }
  }

  /** The last few days of every card again, ahead of whatever history is still queued. */
  private async queueRecent(): Promise<void> {
    const today = this.calendar.today(this.clock.now());
    const from = addDays(today, -(RECENT_DAYS - 1));
    const head = await this.store.nextWindow();
    // Already at the head of the queue: asking twice would only spend the bank's minutes.
    if (head && head.from === from && head.to === today) return;
    if (!head) await this.store.dropFinishedWindows();
    for (const account of await this.store.accounts()) {
      if (account.kind === 'card') {
        await this.store.addWindow(account.providerAccountId, from, today, 0);
      }
    }
  }

  /** Asked for by the person: balances and the last few days again. */
  async refresh(): Promise<void> {
    if (this.state.status === 'not-connected' || this.state.status === 'needs-token') return;
    await this.queueRecent();
    await this.store.setMeta('balancesAt', '0');
    const counts = await this.store.windowCounts();
    this.set({
      status: 'waiting',
      windowsDone: counts.done,
      windowsTotal: counts.total,
      nextAt: null,
    });
  }

  async disconnect(): Promise<void> {
    await this.vault.forget();
    await this.store.clearBank();
    this.set({
      status: 'not-connected',
      windowsDone: 0,
      windowsTotal: 0,
      nextAt: null,
      balancesAt: null,
    });
  }

  /**
   * Does the next thing that is due, one bank read at most, and returns how many milliseconds to wait before calling
   * again, or null when there is nothing to come back for (not connected, or the token has to be replaced).
   */
  async step(): Promise<number | null> {
    const { status } = this.state;
    if (status === 'not-connected' || status === 'needs-token') return null;
    const token = await this.token();
    if (token === null) {
      this.set({ status: 'not-connected' });
      return null;
    }
    const tokens = { accessToken: token };
    const { limits } = this.bank.provider;
    const now = this.now();

    try {
      if (now - (await this.time('ratesAt')) >= RATES_FRESH_MS) {
        // Public rates need no token and are not part of the per-token limit; a failure keeps the old ones.
        await this.store.setMeta('ratesAt', String(now));
        try {
          const rates = await this.bank.provider.fetchRates(CTX);
          if (rates.length > 0) await this.store.setMeta('rates', JSON.stringify(rates));
        } catch {
          // The balances still show, each in its own currency.
        }
      }

      const blockedUntil = await this.time('blockedUntil');
      if (now < blockedUntil) return this.wait(blockedUntil);

      const infoDue = (await this.time('infoAt')) + limits.infoIntervalMs;
      if (now - (await this.time('balancesAt')) >= BALANCES_FRESH_MS) {
        if (now < infoDue) return this.wait(infoDue);
        this.set({ status: 'loading', nextAt: null });
        await this.store.setMeta('infoAt', String(now));
        const accounts = await this.bank.provider.fetchAccounts(tokens, CTX);
        await this.store.replaceAccounts(accounts);
        await this.store.setMeta('balancesAt', String(now));
        // With the history in, new balances usually mean new rows: read the last days too.
        if (!(await this.store.nextWindow())) await this.queueRecent();
        this.set({ balancesAt: now });
        return this.after(0);
      }

      const window = await this.store.nextWindow();
      if (!window) {
        this.set({ status: 'up-to-date', nextAt: null });
        return BALANCES_FRESH_MS;
      }
      const statementDue = (await this.time('statementAt')) + limits.statementIntervalMs;
      if (now < statementDue) return this.wait(statementDue);

      const account = (await this.store.accounts()).find(
        (a) => a.providerAccountId === window.accountId,
      );
      if (!account) {
        await this.store.finishWindow(window.id);
        return this.after(0);
      }
      this.set({ status: 'loading', nextAt: null });
      await this.store.setMeta('statementAt', String(now));
      const rows = await this.bank.provider.fetchTransactions(
        tokens,
        { providerAccountId: account.providerAccountId, currency: account.currency },
        { from: window.from, to: window.to },
        CTX,
      );
      await this.store.upsertTransactions(
        rows.map((row) => toRow(account.providerAccountId, row, account.cardType === 'fop')),
      );
      if (rows.length >= limits.maxItemsPerCall) {
        // The bank cut the answer short: the rest of the window, up to the oldest row it gave, goes next.
        const oldest = rows.reduce((min, row) => Math.min(min, row.ts), Number.POSITIVE_INFINITY);
        const oldestDay = this.calendar.dayKey(oldest);
        // Only while that makes the window shorter: a single day with more rows than one answer holds stops here.
        if (oldestDay < window.to) {
          await this.store.addWindow(account.providerAccountId, window.from, oldestDay, 0);
        }
      }
      await this.store.finishWindow(window.id);
      return this.after(limits.statementIntervalMs);
    } catch (error) {
      return this.failed(error);
    }
  }

  private async after(ms: number): Promise<number> {
    const counts = await this.store.windowCounts();
    const more = counts.done < counts.total;
    this.set({
      status: more ? 'waiting' : 'up-to-date',
      windowsDone: counts.done,
      windowsTotal: counts.total,
      nextAt: more && ms > 0 ? this.now() + ms : null,
    });
    return more ? ms : Math.max(ms, 1_000);
  }

  private wait(until: number): number {
    this.set({ status: 'waiting', nextAt: until });
    return Math.max(250, until - this.now());
  }

  private async failed(error: unknown): Promise<number | null> {
    if (error instanceof TokenRejectedError) {
      await this.store.setMeta('tokenRejected', '1');
      this.set({ status: 'needs-token', nextAt: null });
      return null;
    }
    if (error instanceof AppError && error.code === 'rate_limited') {
      // Someone else used this token's minute: most likely the person's own computer.
      const until = this.now() + (error.retryAfterSeconds ?? 60) * 1000;
      await this.store.setMeta('blockedUntil', String(until));
      return this.wait(until);
    }
    const until = this.now() + 60_000;
    await this.store.setMeta('blockedUntil', String(until));
    this.set({ status: 'bank-down', nextAt: until });
    return 60_000;
  }
}
