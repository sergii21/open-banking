import type { SyncState } from '@ledger-lens/contracts';
import type { AccountRecord, ConnectionRecord } from '../../db/repos';
import { type Calendar, addDays, planWindows } from '../../domain/calendar';
import { categorise } from '../../domain/categoriser';
import { AppError, notFound } from '../../errors';
import type { ProviderAccount, ProviderLimits, ProviderTransaction } from '../../providers/port';
import type { CoreContext } from '../../types';
import type { ConnectionAccess } from '../connection/access';

const MAX_ATTEMPTS = 3;
/** After an outage or an unexpected answer, wait this long before the same step is tried again. */
const RETRY_MS = 30_000;
/** While someone is looking, keep what they see this fresh (when the bank's limit leaves room). */
const TOPUP_EVERY_MS = { main: 120_000, card: 600_000, jar: 1_800_000 };
const BALANCES_EVERY_MS = 5 * 60_000;
/** How far back a top-up reads: enough to catch holds that settled and late items. */
const TOPUP_OVERLAP_DAYS = 3;
const MAX_MONTHS = 13;
const MAX_STEPS_PER_TICK = 60;

interface Gate {
  /** Earliest moment each endpoint may be called again. */
  nextInfoAt: number;
  nextStatementAt: number;
  /** Learned from a 429: this bank counts both endpoints against one limit. */
  shared: boolean;
  lastInfoAt: number;
  lastStatementAt: number;
  lastUserRefreshAt: number;
}

interface Problem {
  message: string;
  needsToken: boolean;
}

/**
 * Brings the cache in line with the bank, inside the bank's limit. monobank allows one read a minute per endpoint, so
 * nothing here ever waits on the bank for a screen: connecting reads the account list once and Home renders from it,
 * then a queue of statement windows (the main card's newest month first) is worked off one per minute, each step
 * announced over SSE so the screens fill in as data arrives. In memory: when each endpoint may be called again (a
 * restart at worst earns one 429, which re-arms it). In the database: the queue itself.
 */
export class SyncService {
  private readonly gates = new Map<string, Gate>();
  private readonly running = new Set<string>();
  /** A statement read is on the wire right now (the sync chip says "loading" only then). */
  private readonly inflight = new Set<string>();
  private readonly problems = new Map<string, Problem>();
  private version = Math.floor(Date.now() / 1000);

  constructor(
    private readonly core: CoreContext,
    private readonly access: ConnectionAccess,
    private readonly calendar: Calendar,
  ) {}

  // ------------------------------------------------------------------------------ small helpers

  private gate(connectionId: string): Gate {
    let gate = this.gates.get(connectionId);
    if (!gate) {
      gate = {
        nextInfoAt: 0,
        nextStatementAt: 0,
        shared: false,
        lastInfoAt: 0,
        lastStatementAt: 0,
        lastUserRefreshAt: 0,
      };
      this.gates.set(connectionId, gate);
    }
    return gate;
  }

  private statementOpensAt(gate: Gate): number {
    return gate.shared ? Math.max(gate.nextInfoAt, gate.nextStatementAt) : gate.nextStatementAt;
  }

  private infoOpensAt(gate: Gate): number {
    return gate.shared ? Math.max(gate.nextInfoAt, gate.nextStatementAt) : gate.nextInfoAt;
  }

  private limitsOf(connection: ConnectionRecord): ProviderLimits {
    return this.access.limitsFor(connection);
  }

  private nowMs(): number {
    return this.core.clock.now().getTime();
  }

  private bump(connection: ConnectionRecord): void {
    this.version += 1;
    this.publish(connection);
  }

  private publish(connection: ConnectionRecord): void {
    const fresh = this.core.repos.connections.findById(connection.id) ?? connection;
    this.core.events.publish(connection.sessionId, {
      type: 'sync.updated',
      sync: this.state(fresh),
    });
  }

  private mainAccount(accounts: readonly AccountRecord[]): AccountRecord | undefined {
    return (
      accounts.find((a) => a.kind === 'card' && a.currency === 'UAH') ??
      accounts.find((a) => a.kind === 'card') ??
      accounts[0]
    );
  }

  private toNew(row: ProviderTransaction, account: AccountRecord) {
    return {
      providerTxnId: row.providerTxnId,
      ts: row.ts,
      status: row.status,
      amountMinor: row.amountMinor,
      currency: row.currency,
      description: row.description,
      counterparty: row.counterparty,
      category: categorise({
        description: row.description,
        counterparty: row.counterparty,
        comment: row.comment,
        amountMinor: row.amountMinor,
        mcc: row.mcc,
        fop: account.cardType === 'fop',
      }),
      mcc: row.mcc,
      cashbackMinor: row.cashbackMinor,
      commissionMinor: row.commissionMinor,
      comment: row.comment,
      receiptId: row.receiptId,
      balanceAfterMinor: row.balanceAfterMinor,
    };
  }

  /** Stores the account list the bank just sent. Own funds are derived later; the bank's balance is kept as it came. */
  private storeAccounts(
    connection: ConnectionRecord,
    accounts: readonly ProviderAccount[],
  ): AccountRecord[] {
    const nowIso = this.core.clock.now().toISOString();
    const stored = this.core.db.transaction(() => {
      const rows = accounts.map((account) =>
        this.core.repos.accounts.upsert(connection.id, {
          providerAccountId: account.providerAccountId,
          kind: account.kind,
          cardType: account.cardType,
          name: account.name,
          currency: account.currency,
          last4: account.last4,
          creditLimitMinor: account.creditLimitMinor,
          balanceMinor: account.balanceMinor,
          goalMinor: account.goalMinor,
          sort: account.sort,
          balanceAt: nowIso,
        }),
      );
      this.core.repos.accounts.deleteMissing(
        connection.id,
        accounts.map((a) => a.providerAccountId),
      );
      return rows;
    });
    return stored.sort((a, b) => a.sort - b.sort);
  }

  /** Something outside the queue changed what the screens show (new rates): tell them to look again. */
  touch(sessionId: string): void {
    const connection = this.core.repos.connections.findBySession(sessionId);
    if (connection) this.bump(connection);
  }

  // ------------------------------------------------------------------------------ planning

  private priorityFor(
    account: AccountRecord,
    rank: number,
    windowIndex: number,
    isMain: boolean,
  ): number {
    if (account.kind === 'jar') return 500 + windowIndex * 10 + rank;
    if (windowIndex === 0) return isMain ? 10 : 20 + rank;
    return 100 + windowIndex * 10 + (isMain ? 0 : 1 + rank);
  }

  private planHistory(
    connection: ConnectionRecord,
    accounts: readonly AccountRecord[],
    months: number,
  ): number {
    const limits = this.limitsOf(connection);
    const nowIso = this.core.clock.now().toISOString();
    const today = this.calendar.today(this.core.clock.now());
    const windows = planWindows(today, months, limits.maxWindowDays);
    const main = this.mainAccount(accounts);
    let queued = 0;
    accounts.forEach((account, rank) => {
      windows.forEach((window, index) => {
        const covered =
          account.coveredFrom !== null &&
          account.coveredTo !== null &&
          account.coveredFrom <= window.from &&
          account.coveredTo >= window.to;
        // The newest window is always read again: it holds the holds, and things move in it.
        if (covered && index > 0) return;
        this.core.repos.syncJobs.enqueue(
          {
            connectionId: connection.id,
            accountId: account.id,
            kind: 'history',
            from: window.from,
            to: window.to,
            priority: this.priorityFor(account, rank, index, account.id === main?.id),
          },
          nowIso,
        );
        queued += 1;
      });
    });
    return queued;
  }

  private kick(): void {
    if (this.core.config.env === 'test') return;
    setTimeout(() => {
      this.tick().catch((error: unknown) => {
        this.core.log.error({ err: error }, 'background sync failed');
      });
    }, 50).unref();
  }

  // ------------------------------------------------------------------------------ connect

  /** The bank accepted a token (or the demo started): store the accounts it listed and queue the history behind them. */
  afterConnect(
    connection: ConnectionRecord,
    accounts: readonly ProviderAccount[],
    keepHistory: boolean,
  ): void {
    const { repos } = this.core;
    const now = this.nowMs();
    const nowIso = new Date(now).toISOString();
    const limits = this.limitsOf(connection);
    const gate = this.gate(connection.id);
    // The connect call itself was the read of the account list.
    gate.lastInfoAt = now;
    gate.nextInfoAt = now + limits.infoIntervalMs;
    this.problems.delete(connection.id);

    const stored = this.storeAccounts(connection, accounts);
    repos.syncJobs.cancelPending(connection.id, 'superseded', nowIso);
    repos.syncJobs.purgeFinished(connection.id);
    repos.connections.update(connection.id, { lastRefreshedAt: nowIso, status: 'active' }, nowIso);
    this.planHistory(
      connection,
      stored,
      keepHistory ? connection.historyMonths : limits.historyMonths,
    );
    this.bump(connection);
    this.kick();
  }

  // ------------------------------------------------------------------------------ the loop

  /** One step for every connection whose gate is open. Returns how many steps ran. */
  async tick(): Promise<number> {
    let ran = 0;
    for (const connection of this.core.repos.connections.listActive()) {
      if (this.running.has(connection.id)) continue;
      this.running.add(connection.id);
      try {
        // Work off every step the bank's limit allows right now: one for monobank, the whole queue for the demo.
        for (let i = 0; i < MAX_STEPS_PER_TICK && (await this.step(connection)); i += 1) ran += 1;
      } catch (error) {
        this.core.log.error({ err: error, connectionId: connection.id }, 'sync step crashed');
      } finally {
        this.running.delete(connection.id);
      }
    }
    return ran;
  }

  private async step(connection: ConnectionRecord): Promise<boolean> {
    const { repos } = this.core;
    const gate = this.gate(connection.id);
    const now = this.nowMs();

    // Keep balances fresh for someone who is looking, when the account-list endpoint is idle.
    const watching = this.core.events.subscriberCount(connection.sessionId) > 0;
    if (
      watching &&
      now >= this.infoOpensAt(gate) &&
      now - gate.lastInfoAt > BALANCES_EVERY_MS &&
      !repos.syncJobs.next(connection.id)
    ) {
      await this.readAccounts(connection);
      return true;
    }

    let job = repos.syncJobs.next(connection.id);
    if (!job && watching) {
      this.queueTopUpIfStale(connection);
      job = repos.syncJobs.next(connection.id);
    }
    if (!job) {
      repos.syncJobs.purgeFinished(connection.id);
      return false;
    }
    if (now < this.statementOpensAt(gate)) return false;
    return this.runJob(connection, job);
  }

  private queueTopUpIfStale(connection: ConnectionRecord): void {
    const { repos } = this.core;
    const now = this.nowMs();
    const accounts = repos.accounts.listByConnection(connection.id);
    const main = this.mainAccount(accounts);
    let pick: { account: AccountRecord; age: number } | null = null;
    for (const account of accounts) {
      const last = account.lastStatementAt ? Date.parse(account.lastStatementAt) : 0;
      const every =
        account.id === main?.id
          ? TOPUP_EVERY_MS.main
          : account.kind === 'jar'
            ? TOPUP_EVERY_MS.jar
            : TOPUP_EVERY_MS.card;
      const age = now - last;
      if (age >= every && (!pick || age / every > pick.age / every)) pick = { account, age };
    }
    if (pick && !repos.syncJobs.hasPending(pick.account.id, 'topup'))
      this.enqueueTopUp(connection, pick.account, 1);
  }

  private enqueueTopUp(
    connection: ConnectionRecord,
    account: AccountRecord,
    priority: number,
  ): void {
    const today = this.calendar.today(this.core.clock.now());
    const limits = this.limitsOf(connection);
    const latest = this.core.repos.transactions.latestTs(account.id);
    const earliest = addDays(today, -(limits.maxWindowDays - 1));
    const wanted = latest ? addDays(this.calendar.dayKey(latest), -TOPUP_OVERLAP_DAYS) : earliest;
    this.core.repos.syncJobs.enqueue(
      {
        connectionId: connection.id,
        accountId: account.id,
        kind: 'topup',
        from: wanted > earliest ? wanted : earliest,
        to: today,
        priority,
      },
      this.core.clock.now().toISOString(),
    );
  }

  private async runJob(
    connection: ConnectionRecord,
    job: {
      id: string;
      accountId: string;
      kind: 'history' | 'topup';
      from: string;
      to: string;
      priority: number;
      attempts: number;
    },
  ): Promise<boolean> {
    const { repos } = this.core;
    const account = repos.accounts.findById(job.accountId);
    if (!account) {
      repos.syncJobs.markDone(job.id, this.core.clock.now().toISOString());
      return true;
    }
    const gate = this.gate(connection.id);
    const startedAt = this.nowMs();
    this.inflight.add(connection.id);
    this.publish(connection);
    let rows: ProviderTransaction[];
    try {
      rows = await this.access.withTokens(connection, (tokens, provider, call) =>
        provider.fetchTransactions(
          tokens,
          { providerAccountId: account.providerAccountId, currency: account.currency },
          { from: job.from, to: job.to },
          call,
        ),
      );
    } catch (error) {
      this.inflight.delete(connection.id);
      this.failed(connection, job, error, startedAt);
      this.publish(connection);
      return false;
    }
    this.inflight.delete(connection.id);
    const limits = this.limitsOf(connection);
    gate.lastStatementAt = startedAt;
    gate.nextStatementAt = startedAt + limits.statementIntervalMs;
    this.store(connection, account, job, rows, limits);
    this.problems.delete(connection.id);
    if (!repos.syncJobs.next(connection.id)) repos.syncJobs.purgeFinished(connection.id);
    this.bump(connection);
    return true;
  }

  private store(
    connection: ConnectionRecord,
    account: AccountRecord,
    job: { id: string; from: string; to: string; priority: number; kind: 'history' | 'topup' },
    rows: readonly ProviderTransaction[],
    limits: ProviderLimits,
  ): void {
    const { repos, clock } = this.core;
    const nowIso = clock.now().toISOString();
    const fromTs = this.calendar.dayStart(job.from);
    const toTs = Math.min(this.calendar.dayEnd(job.to), clock.now().getTime());
    const capped = rows.length >= limits.maxItemsPerCall;
    const oldest = rows.reduce((min, row) => Math.min(min, row.ts), Number.POSITIVE_INFINITY);
    const oldestDay = Number.isFinite(oldest) ? this.calendar.dayKey(oldest) : job.from;

    this.core.db.transaction(() => {
      repos.transactions.upsertMany(
        account.id,
        rows.map((row) => this.toNew(row, account)),
      );
      repos.transactions.dropStalePending(
        account.id,
        fromTs,
        toTs,
        new Set(rows.map((row) => row.providerTxnId)),
      );
      // The loaded span only grows when the new window touches it, and a window the bank cut short counts from its oldest row.
      const today = this.calendar.today(clock.now());
      const touches =
        account.coveredFrom === null
          ? job.to >= addDays(today, -1)
          : job.to >= addDays(account.coveredFrom, -1);
      if (touches) {
        repos.accounts.extendCoverage(account.id, capped ? oldestDay : job.from, job.to, nowIso);
      } else {
        repos.accounts.extendCoverage(
          account.id,
          account.coveredFrom ?? job.from,
          account.coveredTo ?? job.to,
          nowIso,
        );
      }
      repos.syncJobs.markDone(job.id, nowIso);
      repos.connections.update(connection.id, { lastRefreshedAt: nowIso }, nowIso);
      // A response at the row cap may have cut the window short: queue the older rest of it right behind this one.
      if (capped && oldestDay > job.from) {
        repos.syncJobs.enqueue(
          {
            connectionId: connection.id,
            accountId: account.id,
            kind: 'history',
            from: job.from,
            to: oldestDay,
            priority: job.priority + 0.001,
          },
          nowIso,
        );
      }
    });
  }

  private failed(
    connection: ConnectionRecord,
    job: { id: string; attempts: number },
    error: unknown,
    startedAt: number,
  ): void {
    const { repos } = this.core;
    const gate = this.gate(connection.id);
    const nowIso = this.core.clock.now().toISOString();
    if (error instanceof AppError) {
      if (error.code === 'rate_limited') {
        // The bank is the authority on its own limit: wait as long as it says and try the same step again.
        const wait = (error.retryAfterSeconds ?? 60) * 1000;
        // A 429 so soon after reading the account list means the two endpoints share one limit.
        if (startedAt - gate.lastInfoAt < this.limitsOf(connection).infoIntervalMs)
          gate.shared = true;
        gate.nextStatementAt = startedAt + wait;
        return;
      }
      if (error.code === 'reauth_required') {
        repos.syncJobs.cancelPending(connection.id, 'reauth_required', nowIso);
        this.problems.set(connection.id, {
          message: 'monobank no longer accepts your token. Paste a new one.',
          needsToken: true,
        });
        return;
      }
      if (error.code === 'bank_unavailable') {
        gate.nextStatementAt = startedAt + RETRY_MS;
        this.problems.set(connection.id, {
          message: 'monobank is not responding. Trying again shortly.',
          needsToken: false,
        });
        return;
      }
    }
    this.core.log.warn(
      { connectionId: connection.id, code: error instanceof AppError ? error.code : 'unexpected' },
      'background sync step failed',
    );
    repos.syncJobs.recordFailure(
      job.id,
      error instanceof AppError ? error.code : 'unexpected',
      MAX_ATTEMPTS,
      nowIso,
    );
    gate.nextStatementAt = startedAt + RETRY_MS;
    if (job.attempts + 1 >= MAX_ATTEMPTS) {
      this.problems.set(connection.id, {
        message: 'Part of the history could not be loaded. Refresh to try again.',
        needsToken: false,
      });
    }
  }

  // ------------------------------------------------------------------------------ account list

  /** Reads the account list now (balances), if monobank's limit allows. */
  private async readAccounts(connection: ConnectionRecord): Promise<boolean> {
    const gate = this.gate(connection.id);
    const startedAt = this.nowMs();
    try {
      const accounts = await this.access.withTokens(connection, (tokens, provider, call) =>
        provider.fetchAccounts(tokens, call),
      );
      const limits = this.limitsOf(connection);
      gate.lastInfoAt = startedAt;
      gate.nextInfoAt = startedAt + limits.infoIntervalMs;
      this.storeAccounts(connection, accounts);
      this.core.repos.connections.update(
        connection.id,
        { lastRefreshedAt: new Date(startedAt).toISOString() },
        new Date(startedAt).toISOString(),
      );
      this.problems.delete(connection.id);
      this.bump(connection);
      return true;
    } catch (error) {
      if (error instanceof AppError && error.code === 'rate_limited') {
        gate.nextInfoAt = startedAt + (error.retryAfterSeconds ?? 60) * 1000;
        if (startedAt - gate.lastStatementAt < this.limitsOf(connection).statementIntervalMs)
          gate.shared = true;
      } else if (error instanceof AppError && error.code === 'reauth_required') {
        this.problems.set(connection.id, {
          message: 'monobank no longer accepts your token. Paste a new one.',
          needsToken: true,
        });
      } else if (error instanceof AppError && error.code === 'bank_unavailable') {
        gate.nextInfoAt = startedAt + RETRY_MS;
        this.problems.set(connection.id, {
          message: 'monobank is not responding. Trying again shortly.',
          needsToken: false,
        });
      } else {
        throw error;
      }
      this.publish(connection);
      return false;
    }
  }

  // ------------------------------------------------------------------------------ what the person can ask for

  /** Refresh: read balances now if the limit allows, and queue fresh reads of the cards behind whatever is already queued. */
  async refresh(sessionId: string): Promise<SyncState> {
    const connection = this.requireConnection(sessionId);
    this.access.assertUsable(connection);
    const gate = this.gate(connection.id);
    const now = this.nowMs();
    const cooldown = this.core.config.refreshCooldownSeconds * 1000;
    if (now - gate.lastUserRefreshAt < cooldown) {
      throw new AppError('refresh_cooldown', 429, 'Refreshed a moment ago.', {
        retryAfterSeconds: Math.ceil((cooldown - (now - gate.lastUserRefreshAt)) / 1000),
      });
    }
    gate.lastUserRefreshAt = now;
    this.problems.delete(connection.id);

    const accounts = this.core.repos.accounts.listByConnection(connection.id);
    accounts.forEach((account, rank) => {
      if (!this.core.repos.syncJobs.hasPending(account.id, 'topup')) {
        this.enqueueTopUp(
          connection,
          account,
          account.kind === 'jar' ? 3 : rank === 0 ? 0 : 1 + rank / 100,
        );
      }
    });
    if (now >= this.infoOpensAt(gate) && !this.running.has(connection.id)) {
      this.running.add(connection.id);
      try {
        await this.readAccounts(connection);
      } finally {
        this.running.delete(connection.id);
      }
    }
    this.kick();
    return this.state(this.core.repos.connections.findById(connection.id) ?? connection);
  }

  /** "Load earlier months": one more month of history for every account, behind whatever is queued. */
  loadEarlier(sessionId: string): SyncState {
    const connection = this.requireConnection(sessionId);
    this.access.assertUsable(connection);
    const progress = this.core.repos.syncJobs.progress(connection.id);
    if (progress.pending > 0 || connection.historyMonths >= MAX_MONTHS)
      return this.state(connection);
    const months = connection.historyMonths + 1;
    this.core.repos.connections.update(
      connection.id,
      { historyMonths: months },
      this.core.clock.now().toISOString(),
    );
    const accounts = this.core.repos.accounts.listByConnection(connection.id);
    this.planHistory({ ...connection, historyMonths: months }, accounts, months);
    this.bump(connection);
    this.kick();
    return this.state(this.core.repos.connections.findById(connection.id) ?? connection);
  }

  /** "Load this card first": its queued history jumps the queue. */
  prioritise(sessionId: string, accountId: string): SyncState {
    const connection = this.requireConnection(sessionId);
    const account = this.core.repos.accounts.findForSession(sessionId, accountId);
    if (!account) throw notFound('Account');
    this.core.repos.syncJobs.prioritise(account.id, 5);
    this.publish(connection);
    this.kick();
    return this.state(connection);
  }

  private requireConnection(sessionId: string): ConnectionRecord {
    const connection = this.core.repos.connections.findBySession(sessionId);
    if (!connection) throw notFound('Connection');
    return connection;
  }

  // ------------------------------------------------------------------------------ state for the screens

  accountStates(connection: ConnectionRecord): Map<string, { pending: number; done: number }> {
    return this.core.repos.syncJobs.accountStates(connection.id);
  }

  state(connection: ConnectionRecord): SyncState {
    const now = this.nowMs();
    const progress = this.core.repos.syncJobs.progress(connection.id);
    const gate = this.gate(connection.id);
    const problem = this.problems.get(connection.id);
    const opensAt = this.statementOpensAt(gate);
    const needsToken = connection.status === 'needs_reauth' || (problem?.needsToken ?? false);

    let phase: SyncState['phase'] = 'idle';
    if (needsToken || problem) phase = 'attention';
    else if (this.inflight.has(connection.id)) phase = 'loading';
    else if (progress.pending > 0) phase = now >= opensAt ? 'loading' : 'waiting';

    return {
      phase,
      updatedAt: connection.lastRefreshedAt,
      done: progress.done,
      total: progress.total,
      nextAt: progress.pending > 0 ? new Date(Math.max(now, opensAt)).toISOString() : null,
      balancesNextAt:
        now < this.infoOpensAt(gate) ? new Date(this.infoOpensAt(gate)).toISOString() : null,
      needsToken,
      message: needsToken
        ? 'monobank no longer accepts your token. Paste a new one.'
        : (problem?.message ?? null),
      version: this.version,
    };
  }
}
