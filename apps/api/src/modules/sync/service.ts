import type { SyncState } from '@ledger-lens/contracts';
import type { AccountRecord, ConnectionRecord } from '../../db/repos';
import { type Calendar, addDays, planWindows } from '../../domain/calendar';
import { categorise } from '../../domain/categoriser';
import { AppError, notFound } from '../../errors';
import type { ProviderAccount, ProviderLimits, ProviderTransaction } from '../../providers/port';
import type { CoreContext } from '../../types';
import type { ConnectionAccess } from '../connection/access';
import { BANK_NAME } from '../connection/presenter';

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
}

interface Problem {
  message: string;
  needsToken: boolean;
}

/**
 * Brings the cache in line with the banks, inside each bank's limit. monobank allows one read a minute per endpoint, so
 * nothing here ever waits on the bank for a screen: connecting reads the account list once and Home renders from it,
 * then a queue of statement windows (the main card's newest month first) is worked off one per minute, each step
 * announced over SSE so the screens fill in as data arrives. Every connection has its own queue and its own gate, so one
 * bank's limit never slows another; the screens see one state for the session (`stateForSession`). In memory: when each
 * endpoint may be called again (a restart at worst earns one 429, which re-arms it). In the database: the queues.
 */
export class SyncService {
  private readonly gates = new Map<string, Gate>();
  private readonly running = new Set<string>();
  /** A statement read is on the wire right now (the sync chip says "loading" only then). */
  private readonly inflight = new Set<string>();
  private readonly problems = new Map<string, Problem>();
  /** When each session last asked for a refresh, so a double click does not read twice. */
  private readonly refreshedAt = new Map<string, number>();
  private version = Math.floor(Date.now() / 1000);

  constructor(
    private readonly core: CoreContext,
    private readonly access: ConnectionAccess,
    private readonly calendar: Calendar,
  ) {}

  // ------------------------------------------------------------------------------ small helpers

  private gate(connection: ConnectionRecord): Gate {
    let gate = this.gates.get(connection.id);
    if (!gate) {
      gate = {
        nextInfoAt: 0,
        nextStatementAt: 0,
        // A bank that documents one limit for everything (PrivatBank: a request a second) starts with the gates joined;
        // for monobank the first 429 right after the account list teaches it.
        shared: this.limitsOf(connection).sharedLimit === true,
        lastInfoAt: 0,
        lastStatementAt: 0,
      };
      this.gates.set(connection.id, gate);
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
    this.core.events.publish(connection.sessionId, {
      type: 'sync.updated',
      sync: this.stateForSession(connection.sessionId),
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
        fop: account.cardType === 'fop' || account.cardType === 'business',
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

  /** Something outside the queue changed what the screens show (new rates, an import, a bank removed): tell them to look again. */
  touch(sessionId: string): void {
    this.version += 1;
    this.core.events.publish(sessionId, {
      type: 'sync.updated',
      sync: this.stateForSession(sessionId),
    });
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
    const gate = this.gate(connection);
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
    const gate = this.gate(connection);
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
    const gate = this.gate(connection);
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
    // From the end of the read: a bank that is paged (PrivatBank) makes several requests inside one step.
    gate.nextStatementAt = Math.max(startedAt, this.nowMs()) + limits.statementIntervalMs;
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
    const gate = this.gate(connection);
    const nowIso = this.core.clock.now().toISOString();
    const name = BANK_NAME[connection.provider];
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
          message: this.access.reauthMessage(connection),
          needsToken: true,
        });
        return;
      }
      if (error.code === 'bank_unavailable') {
        gate.nextStatementAt = startedAt + RETRY_MS;
        this.problems.set(connection.id, {
          message: this.unavailableMessage(connection, error),
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
        message: `Part of the ${name} history could not be loaded. Refresh to try again.`,
        needsToken: false,
      });
    }
  }

  /** An adapter that knows why its bank is not answering (PrivatBank's daily routine) says so; otherwise the generic words. */
  private unavailableMessage(connection: ConnectionRecord, error: AppError): string {
    const name = BANK_NAME[connection.provider];
    return error.message.startsWith(name)
      ? error.message
      : `${name} is not responding. Trying again shortly.`;
  }

  // ------------------------------------------------------------------------------ account list

  /** Reads the account list now (balances), if the bank's limit allows. */
  private async readAccounts(connection: ConnectionRecord): Promise<boolean> {
    const gate = this.gate(connection);
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
          message: this.access.reauthMessage(connection),
          needsToken: true,
        });
      } else if (error instanceof AppError && error.code === 'bank_unavailable') {
        gate.nextInfoAt = startedAt + RETRY_MS;
        this.problems.set(connection.id, {
          message: this.unavailableMessage(connection, error),
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

  /** The session's banks that are read through a token (an imported file has nothing to refresh). */
  private apiConnections(sessionId: string): ConnectionRecord[] {
    return this.core.repos.connections.listBySession(sessionId).filter((c) => c.kind === 'api');
  }

  /** Refresh: read balances now where the limit allows, and queue fresh reads of the cards behind whatever is already queued. */
  async refresh(sessionId: string): Promise<SyncState> {
    const all = this.apiConnections(sessionId);
    const first = all[0];
    if (!first) return this.stateForSession(sessionId);
    const usable = all.filter((c) => c.status === 'active');
    // Only when no bank can be refreshed is the answer an error; one bank asking for a token must not stop the others.
    if (usable.length === 0) this.access.assertUsable(first);

    const now = this.nowMs();
    const cooldown = this.core.config.refreshCooldownSeconds * 1000;
    const last = this.refreshedAt.get(sessionId) ?? 0;
    if (now - last < cooldown) {
      throw new AppError('refresh_cooldown', 429, 'Refreshed a moment ago.', {
        retryAfterSeconds: Math.ceil((cooldown - (now - last)) / 1000),
      });
    }
    this.refreshedAt.set(sessionId, now);

    for (const connection of usable) {
      const gate = this.gate(connection);
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
    }
    this.kick();
    return this.stateForSession(sessionId);
  }

  /** "Load earlier months": one more month of history for every account of the bank (or of every bank), behind whatever is queued. */
  loadEarlier(sessionId: string, connectionId?: string): SyncState {
    const targets = this.apiConnections(sessionId).filter(
      (c) => c.status === 'active' && (connectionId === undefined || c.id === connectionId),
    );
    if (connectionId !== undefined && targets.length === 0) throw notFound('Connection');
    for (const connection of targets) {
      const progress = this.core.repos.syncJobs.progress(connection.id);
      if (progress.pending > 0 || connection.historyMonths >= MAX_MONTHS) continue;
      const months = connection.historyMonths + 1;
      this.core.repos.connections.update(
        connection.id,
        { historyMonths: months },
        this.core.clock.now().toISOString(),
      );
      const accounts = this.core.repos.accounts.listByConnection(connection.id);
      this.planHistory({ ...connection, historyMonths: months }, accounts, months);
    }
    if (targets[0]) this.bump(targets[0]);
    this.kick();
    return this.stateForSession(sessionId);
  }

  /** "Load this card first": its queued history jumps the queue. */
  prioritise(sessionId: string, accountId: string): SyncState {
    const account = this.core.repos.accounts.findForSession(sessionId, accountId);
    if (!account) throw notFound('Account');
    const connection = this.core.repos.connections.findById(account.connectionId);
    this.core.repos.syncJobs.prioritise(account.id, 5);
    if (connection) this.publish(connection);
    this.kick();
    return this.stateForSession(sessionId);
  }

  // ------------------------------------------------------------------------------ state for the screens

  /** Per account: reads still queued and finished, across every bank of the session. */
  accountStates(sessionId: string): Map<string, { pending: number; done: number }> {
    const merged = new Map<string, { pending: number; done: number }>();
    for (const connection of this.apiConnections(sessionId)) {
      for (const [id, state] of this.core.repos.syncJobs.accountStates(connection.id)) {
        merged.set(id, state);
      }
    }
    return merged;
  }

  /** One bank's loader. The screens use `stateForSession`, which folds these together. */
  state(connection: ConnectionRecord): SyncState {
    const now = this.nowMs();
    const progress = this.core.repos.syncJobs.progress(connection.id);
    const gate = this.gate(connection);
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
      message: needsToken ? this.access.reauthMessage(connection) : (problem?.message ?? null),
      version: this.version,
    };
  }

  /**
   * What the sync chip and Home show for the whole session: the busiest phase wins (attention, then loading, then waiting),
   * steps add up, and the nearest next step is the one announced. An imported file only moves `updatedAt`.
   */
  stateForSession(sessionId: string): SyncState {
    const all = this.core.repos.connections.listBySession(sessionId);
    const states = all.filter((c) => c.kind === 'api').map((c) => this.state(c));
    const stamps = all.flatMap((c) => (c.lastRefreshedAt ? [c.lastRefreshedAt] : []));
    const updatedAt = stamps.length > 0 ? stamps.reduce((a, b) => (a > b ? a : b)) : null;
    const earliest = (values: (string | null)[]): string | null => {
      const present = values.filter((v): v is string => v !== null);
      return present.length > 0 ? present.reduce((a, b) => (a < b ? a : b)) : null;
    };
    const rank: Record<SyncState['phase'], number> = {
      idle: 0,
      waiting: 1,
      loading: 2,
      attention: 3,
    };
    const phase = states.reduce<SyncState['phase']>(
      (best, s) => (rank[s.phase] > rank[best] ? s.phase : best),
      'idle',
    );
    const messages = [...new Set(states.flatMap((s) => (s.message ? [s.message] : [])))];
    return {
      phase,
      updatedAt,
      done: states.reduce((n, s) => n + s.done, 0),
      total: states.reduce((n, s) => n + s.total, 0),
      nextAt: earliest(states.map((s) => s.nextAt)),
      balancesNextAt: earliest(states.map((s) => s.balancesNextAt)),
      needsToken: states.some((s) => s.needsToken),
      message: messages.length > 0 ? messages.join(' ') : null,
      version: this.version,
    };
  }
}
