import type { Category, ProviderId } from '@ledger-lens/contracts';
import { newId } from '../domain/crypto';
import type { Db } from './database';

// ================================================================================================= sessions

export interface SessionRecord {
  id: string;
  createdAt: string;
  lastSeenAt: string;
}

export class SessionsRepo {
  constructor(private readonly db: Db) {}

  create(id: string, now: string): SessionRecord {
    this.db.run(
      'INSERT INTO sessions (id, created_at, last_seen_at) VALUES (?, ?, ?)',
      id,
      now,
      now,
    );
    return { id, createdAt: now, lastSeenAt: now };
  }

  find(id: string): SessionRecord | undefined {
    const row = this.db.get<{ id: string; created_at: string; last_seen_at: string }>(
      'SELECT * FROM sessions WHERE id = ?',
      id,
    );
    return row
      ? { id: row.id, createdAt: row.created_at, lastSeenAt: row.last_seen_at }
      : undefined;
  }

  touch(id: string, now: string): void {
    this.db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', now, id);
  }

  /** Deletes the session and, through ON DELETE CASCADE, its connection, accounts, transactions and queued reads. */
  delete(id: string): void {
    this.db.run('DELETE FROM sessions WHERE id = ?', id);
  }

  purgeIdleBefore(iso: string): number {
    return this.db.run('DELETE FROM sessions WHERE last_seen_at < ?', iso).changes;
  }
}

// ============================================================================================= connections

export type ConnectionStatus = 'active' | 'needs_reauth' | 'error';

export interface ConnectionRecord {
  id: string;
  sessionId: string;
  provider: ProviderId;
  status: ConnectionStatus;
  tokensEnc: string | null;
  lastRefreshedAt: string | null;
  historyMonths: number;
  createdAt: string;
  updatedAt: string;
}

interface ConnectionRow {
  id: string;
  session_id: string;
  provider: string;
  status: string;
  tokens_enc: string | null;
  last_refreshed_at: string | null;
  history_months: number;
  created_at: string;
  updated_at: string;
}

const toConnection = (row: ConnectionRow): ConnectionRecord => ({
  id: row.id,
  sessionId: row.session_id,
  provider: row.provider as ProviderId,
  status: row.status as ConnectionStatus,
  tokensEnc: row.tokens_enc,
  lastRefreshedAt: row.last_refreshed_at,
  historyMonths: row.history_months,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export interface ConnectionPatch {
  status?: ConnectionStatus;
  tokensEnc?: string | null;
  lastRefreshedAt?: string;
  historyMonths?: number;
}

const CONNECTION_COLUMNS: Record<keyof ConnectionPatch, string> = {
  status: 'status',
  tokensEnc: 'tokens_enc',
  lastRefreshedAt: 'last_refreshed_at',
  historyMonths: 'history_months',
};

export class ConnectionsRepo {
  constructor(private readonly db: Db) {}

  insert(input: {
    id: string;
    sessionId: string;
    provider: ProviderId;
    tokensEnc: string;
    historyMonths: number;
    now: string;
  }): void {
    this.db.run(
      `INSERT INTO connections (id, session_id, provider, status, tokens_enc, history_months, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`,
      input.id,
      input.sessionId,
      input.provider,
      input.tokensEnc,
      input.historyMonths,
      input.now,
      input.now,
    );
  }

  findById(id: string): ConnectionRecord | undefined {
    const row = this.db.get<ConnectionRow>('SELECT * FROM connections WHERE id = ?', id);
    return row ? toConnection(row) : undefined;
  }

  findBySession(sessionId: string): ConnectionRecord | undefined {
    const row = this.db.get<ConnectionRow>(
      'SELECT * FROM connections WHERE session_id = ?',
      sessionId,
    );
    return row ? toConnection(row) : undefined;
  }

  /** Connections the background loader should look at. */
  listActive(): ConnectionRecord[] {
    return this.db
      .all<ConnectionRow>(`SELECT * FROM connections WHERE status = 'active'`)
      .map(toConnection);
  }

  update(id: string, patch: ConnectionPatch, now: string): void {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    for (const key of Object.keys(patch) as (keyof ConnectionPatch)[]) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${CONNECTION_COLUMNS[key]} = ?`);
      params.push(value);
    }
    if (sets.length === 0) return;
    this.db.run(
      `UPDATE connections SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`,
      ...params,
      now,
      id,
    );
  }

  delete(id: string): void {
    this.db.run('DELETE FROM connections WHERE id = ?', id);
  }
}

// ================================================================================================= accounts

export interface AccountRecord {
  id: string;
  connectionId: string;
  providerAccountId: string;
  kind: 'card' | 'jar';
  cardType: string;
  name: string;
  currency: string;
  last4: string | null;
  creditLimitMinor: number;
  /** As the bank reports it: includes the credit limit. */
  balanceMinor: number;
  goalMinor: number | null;
  sort: number;
  balanceAt: string;
  coveredFrom: string | null;
  coveredTo: string | null;
  lastStatementAt: string | null;
}

interface AccountRow {
  id: string;
  connection_id: string;
  provider_account_id: string;
  kind: string;
  card_type: string;
  name: string;
  currency: string;
  last4: string | null;
  credit_limit_minor: number;
  balance_minor: number;
  goal_minor: number | null;
  sort: number;
  balance_at: string;
  covered_from: string | null;
  covered_to: string | null;
  last_statement_at: string | null;
}

const toAccount = (row: AccountRow): AccountRecord => ({
  id: row.id,
  connectionId: row.connection_id,
  providerAccountId: row.provider_account_id,
  kind: row.kind as 'card' | 'jar',
  cardType: row.card_type,
  name: row.name,
  currency: row.currency,
  last4: row.last4,
  creditLimitMinor: row.credit_limit_minor,
  balanceMinor: row.balance_minor,
  goalMinor: row.goal_minor,
  sort: row.sort,
  balanceAt: row.balance_at,
  coveredFrom: row.covered_from,
  coveredTo: row.covered_to,
  lastStatementAt: row.last_statement_at,
});

export interface AccountUpsert {
  providerAccountId: string;
  kind: 'card' | 'jar';
  cardType: string;
  name: string;
  currency: string;
  last4: string | null;
  creditLimitMinor: number;
  balanceMinor: number;
  goalMinor: number | null;
  sort: number;
  balanceAt: string;
}

export class AccountsRepo {
  constructor(private readonly db: Db) {}

  upsert(connectionId: string, input: AccountUpsert): AccountRecord {
    this.db.run(
      `INSERT INTO accounts (id, connection_id, provider_account_id, kind, card_type, name, currency, last4,
         credit_limit_minor, balance_minor, goal_minor, sort, balance_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (connection_id, provider_account_id) DO UPDATE SET
         kind = excluded.kind, card_type = excluded.card_type, name = excluded.name, currency = excluded.currency,
         last4 = excluded.last4, credit_limit_minor = excluded.credit_limit_minor, balance_minor = excluded.balance_minor,
         goal_minor = excluded.goal_minor, sort = excluded.sort, balance_at = excluded.balance_at`,
      newId('acc'),
      connectionId,
      input.providerAccountId,
      input.kind,
      input.cardType,
      input.name,
      input.currency,
      input.last4,
      input.creditLimitMinor,
      input.balanceMinor,
      input.goalMinor,
      input.sort,
      input.balanceAt,
    );
    const row = this.db.get<AccountRow>(
      'SELECT * FROM accounts WHERE connection_id = ? AND provider_account_id = ?',
      connectionId,
      input.providerAccountId,
    );
    if (!row) throw new Error('account upsert did not store a row');
    return toAccount(row);
  }

  /** Accounts the bank no longer lists are removed with their transactions. */
  deleteMissing(connectionId: string, keepProviderIds: readonly string[]): void {
    const keep = new Set(keepProviderIds);
    for (const account of this.listByConnection(connectionId)) {
      if (!keep.has(account.providerAccountId)) {
        this.db.run('DELETE FROM accounts WHERE id = ?', account.id);
      }
    }
  }

  findById(id: string): AccountRecord | undefined {
    const row = this.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', id);
    return row ? toAccount(row) : undefined;
  }

  listByConnection(connectionId: string): AccountRecord[] {
    return this.db
      .all<AccountRow>(
        'SELECT * FROM accounts WHERE connection_id = ? ORDER BY sort, id',
        connectionId,
      )
      .map(toAccount);
  }

  listBySession(sessionId: string): AccountRecord[] {
    return this.db
      .all<AccountRow>(
        `SELECT a.* FROM accounts a JOIN connections c ON c.id = a.connection_id
         WHERE c.session_id = ? ORDER BY a.sort, a.id`,
        sessionId,
      )
      .map(toAccount);
  }

  findForSession(sessionId: string, id: string): AccountRecord | undefined {
    const row = this.db.get<AccountRow>(
      `SELECT a.* FROM accounts a JOIN connections c ON c.id = a.connection_id
       WHERE c.session_id = ? AND a.id = ?`,
      sessionId,
      id,
    );
    return row ? toAccount(row) : undefined;
  }

  /** A statement window arrived: the loaded span grows to include it. */
  extendCoverage(id: string, from: string, to: string, at: string): void {
    this.db.run(
      `UPDATE accounts SET
         covered_from = CASE WHEN covered_from IS NULL OR ? < covered_from THEN ? ELSE covered_from END,
         covered_to = CASE WHEN covered_to IS NULL OR ? > covered_to THEN ? ELSE covered_to END,
         last_statement_at = ?
       WHERE id = ?`,
      from,
      from,
      to,
      to,
      at,
      id,
    );
  }
}

// ================================================================================================ transactions

export interface TransactionRecord {
  id: string;
  accountId: string;
  providerTxnId: string;
  ts: number;
  status: 'pending' | 'booked';
  amountMinor: number;
  currency: string;
  description: string;
  counterparty: string | null;
  category: Category;
  categorySource: 'auto' | 'user';
  mcc: number | null;
  cashbackMinor: number;
  commissionMinor: number;
  comment: string | null;
  receiptId: string | null;
  balanceAfterMinor: number | null;
}

interface TransactionRow {
  id: string;
  account_id: string;
  provider_txn_id: string;
  ts: number;
  status: string;
  amount_minor: number;
  currency: string;
  description: string;
  counterparty: string | null;
  category: string;
  category_source: string;
  mcc: number | null;
  cashback_minor: number;
  commission_minor: number;
  comment: string | null;
  receipt_id: string | null;
  balance_after_minor: number | null;
}

const toTransaction = (row: TransactionRow): TransactionRecord => ({
  id: row.id,
  accountId: row.account_id,
  providerTxnId: row.provider_txn_id,
  ts: row.ts,
  status: row.status as 'pending' | 'booked',
  amountMinor: row.amount_minor,
  currency: row.currency,
  description: row.description,
  counterparty: row.counterparty,
  category: row.category as Category,
  categorySource: row.category_source as 'auto' | 'user',
  mcc: row.mcc,
  cashbackMinor: row.cashback_minor,
  commissionMinor: row.commission_minor,
  comment: row.comment,
  receiptId: row.receipt_id,
  balanceAfterMinor: row.balance_after_minor,
});

export interface NewTransaction {
  providerTxnId: string;
  ts: number;
  status: 'pending' | 'booked';
  amountMinor: number;
  currency: string;
  description: string;
  counterparty: string | null;
  category: Category;
  mcc: number | null;
  cashbackMinor: number;
  commissionMinor: number;
  comment: string | null;
  receiptId: string | null;
  balanceAfterMinor: number | null;
}

export class TransactionsRepo {
  constructor(private readonly db: Db) {}

  /**
   * Inserts new rows and updates existing ones in place (a hold becoming a booked item keeps its id). A category the person
   * chose is never overwritten. Returns how many rows were new.
   */
  upsertMany(accountId: string, rows: readonly NewTransaction[]): number {
    if (rows.length === 0) return 0;
    const before = this.count(accountId);
    this.db.transaction(() => {
      for (const row of rows) {
        this.db.run(
          `INSERT INTO transactions (id, account_id, provider_txn_id, ts, status, amount_minor, currency, description,
             counterparty, category, category_source, mcc, cashback_minor, commission_minor, comment, receipt_id,
             balance_after_minor)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto', ?, ?, ?, ?, ?, ?)
           ON CONFLICT (account_id, provider_txn_id) DO UPDATE SET
             ts = excluded.ts, status = excluded.status, amount_minor = excluded.amount_minor,
             description = excluded.description, counterparty = excluded.counterparty,
             mcc = excluded.mcc, cashback_minor = excluded.cashback_minor, commission_minor = excluded.commission_minor,
             comment = excluded.comment, receipt_id = excluded.receipt_id, balance_after_minor = excluded.balance_after_minor,
             category = CASE WHEN transactions.category_source = 'user' THEN transactions.category ELSE excluded.category END`,
          newId('txn'),
          accountId,
          row.providerTxnId,
          row.ts,
          row.status,
          row.amountMinor,
          row.currency,
          row.description,
          row.counterparty,
          row.category,
          row.mcc,
          row.cashbackMinor,
          row.commissionMinor,
          row.comment,
          row.receiptId,
          row.balanceAfterMinor,
        );
      }
    });
    return this.count(accountId) - before;
  }

  /**
   * After a window was read: holds the bank no longer reports inside it have settled under another id or been released,
   * so they go. Holds outside the window are left alone.
   */
  dropStalePending(
    accountId: string,
    fromTs: number,
    toTs: number,
    seenProviderIds: ReadonlySet<string>,
  ): number {
    const pending = this.db.all<{ id: string; provider_txn_id: string }>(
      `SELECT id, provider_txn_id FROM transactions
       WHERE account_id = ? AND status = 'pending' AND ts >= ? AND ts <= ?`,
      accountId,
      fromTs,
      toTs,
    );
    let removed = 0;
    for (const row of pending) {
      if (seenProviderIds.has(row.provider_txn_id)) continue;
      this.db.run('DELETE FROM transactions WHERE id = ?', row.id);
      removed += 1;
    }
    return removed;
  }

  count(accountId: string): number {
    return (
      this.db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?',
        accountId,
      )?.n ?? 0
    );
  }

  latestTs(accountId: string): number | undefined {
    return (
      this.db.get<{ ts: number | null }>(
        `SELECT MAX(ts) AS ts FROM transactions WHERE account_id = ? AND status = 'booked'`,
        accountId,
      )?.ts ?? undefined
    );
  }

  /** Every transaction of the session since `sinceTs`, newest first. Screens filter and group these in memory. */
  listForSession(sessionId: string, sinceTs = 0): TransactionRecord[] {
    return this.db
      .all<TransactionRow>(
        `SELECT t.* FROM transactions t
           JOIN accounts a ON a.id = t.account_id
           JOIN connections c ON c.id = a.connection_id
         WHERE c.session_id = ? AND t.ts >= ?
         ORDER BY t.ts DESC, t.id DESC`,
        sessionId,
        sinceTs,
      )
      .map(toTransaction);
  }

  findForSession(sessionId: string, id: string): TransactionRecord | undefined {
    const row = this.db.get<TransactionRow>(
      `SELECT t.* FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         JOIN connections c ON c.id = a.connection_id
       WHERE c.session_id = ? AND t.id = ?`,
      sessionId,
      id,
    );
    return row ? toTransaction(row) : undefined;
  }

  updateCategory(id: string, category: Category): void {
    this.db.run(
      `UPDATE transactions SET category = ?, category_source = 'user' WHERE id = ?`,
      category,
      id,
    );
  }
}

// ================================================================================================== sync jobs

export interface SyncJobRecord {
  id: string;
  connectionId: string;
  accountId: string;
  kind: 'history' | 'topup';
  from: string;
  to: string;
  priority: number;
  attempts: number;
}

interface SyncJobRow {
  id: string;
  connection_id: string;
  account_id: string;
  kind: string;
  window_from: string;
  window_to: string;
  priority: number;
  attempts: number;
}

const toJob = (row: SyncJobRow): SyncJobRecord => ({
  id: row.id,
  connectionId: row.connection_id,
  accountId: row.account_id,
  kind: row.kind as 'history' | 'topup',
  from: row.window_from,
  to: row.window_to,
  priority: row.priority,
  attempts: row.attempts,
});

/** Queue of paced statement reads. Rows survive a restart, so a long history load resumes where it stopped. */
export class SyncJobsRepo {
  constructor(private readonly db: Db) {}

  enqueue(
    input: {
      connectionId: string;
      accountId: string;
      kind: 'history' | 'topup';
      from: string;
      to: string;
      priority: number;
    },
    now: string,
  ): void {
    this.db.run(
      `INSERT INTO sync_jobs (id, connection_id, account_id, kind, window_from, window_to, priority, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      newId('job'),
      input.connectionId,
      input.accountId,
      input.kind,
      input.from,
      input.to,
      input.priority,
      now,
      now,
    );
  }

  next(connectionId: string): SyncJobRecord | undefined {
    const row = this.db.get<SyncJobRow>(
      `SELECT id, connection_id, account_id, kind, window_from, window_to, priority, attempts FROM sync_jobs
       WHERE connection_id = ? AND status = 'pending' ORDER BY priority ASC, created_at ASC, id ASC LIMIT 1`,
      connectionId,
    );
    return row ? toJob(row) : undefined;
  }

  connectionsWithPending(): string[] {
    return this.db
      .all<{ connection_id: string }>(
        `SELECT DISTINCT connection_id FROM sync_jobs WHERE status = 'pending'`,
      )
      .map((row) => row.connection_id);
  }

  markDone(id: string, now: string): void {
    this.db.run(`UPDATE sync_jobs SET status = 'done', updated_at = ? WHERE id = ?`, now, id);
  }

  /** A failed attempt stays pending until `maxAttempts`, then gives up so the queue cannot stall for ever. */
  recordFailure(id: string, error: string, maxAttempts: number, now: string): void {
    this.db.run(
      `UPDATE sync_jobs SET attempts = attempts + 1, last_error = ?, updated_at = ?,
         status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END WHERE id = ?`,
      error,
      now,
      maxAttempts,
      id,
    );
  }

  cancelPending(connectionId: string, reason: string, now: string): void {
    this.db.run(
      `UPDATE sync_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE connection_id = ? AND status = 'pending'`,
      reason,
      now,
      connectionId,
    );
  }

  progress(connectionId: string): { done: number; total: number; pending: number; failed: number } {
    const row = this.db.get<{ total: number; done: number; pending: number; failed: number }>(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(status = 'done'), 0) AS done,
              COALESCE(SUM(status = 'pending'), 0) AS pending,
              COALESCE(SUM(status = 'failed'), 0) AS failed
       FROM sync_jobs WHERE connection_id = ?`,
      connectionId,
    );
    return {
      total: row?.total ?? 0,
      done: row?.done ?? 0,
      pending: row?.pending ?? 0,
      failed: row?.failed ?? 0,
    };
  }

  /** Per account: how many reads are still queued (`pending`) and how many finished, for the "loading" marks on tiles. */
  accountStates(connectionId: string): Map<string, { pending: number; done: number }> {
    const rows = this.db.all<{ account_id: string; pending: number; done: number }>(
      `SELECT account_id, COALESCE(SUM(status = 'pending'), 0) AS pending, COALESCE(SUM(status = 'done'), 0) AS done
       FROM sync_jobs WHERE connection_id = ? GROUP BY account_id`,
      connectionId,
    );
    return new Map(rows.map((r) => [r.account_id, { pending: r.pending, done: r.done }]));
  }

  hasPending(accountId: string, kind: 'history' | 'topup'): boolean {
    return (
      (this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM sync_jobs WHERE account_id = ? AND kind = ? AND status = 'pending'`,
        accountId,
        kind,
      )?.n ?? 0) > 0
    );
  }

  /** Moves every queued history read of one account to the front ("load this card first"). */
  prioritise(accountId: string, priority: number): void {
    this.db.run(
      `UPDATE sync_jobs SET priority = ? + (priority / 1000000.0) WHERE account_id = ? AND status = 'pending' AND kind = 'history'`,
      priority,
      accountId,
    );
  }

  /** Once a batch has finished, forget it so the next one reports its own progress from zero. */
  purgeFinished(connectionId: string): void {
    const pending = this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sync_jobs WHERE connection_id = ? AND status = 'pending'`,
      connectionId,
    );
    if ((pending?.n ?? 0) === 0) {
      this.db.run('DELETE FROM sync_jobs WHERE connection_id = ?', connectionId);
    }
  }
}

// ======================================================================================================= rates

export class RatesRepo {
  constructor(private readonly db: Db) {}

  get(): { payload: string; fetchedAt: string } | undefined {
    const row = this.db.get<{ payload: string; fetched_at: string }>(
      'SELECT payload, fetched_at FROM rates WHERE id = 1',
    );
    return row ? { payload: row.payload, fetchedAt: row.fetched_at } : undefined;
  }

  put(payload: string, fetchedAt: string): void {
    this.db.run(
      `INSERT INTO rates (id, payload, fetched_at) VALUES (1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
      payload,
      fetchedAt,
    );
  }
}

// ================================================================================================== bundle

export interface Repositories {
  sessions: SessionsRepo;
  connections: ConnectionsRepo;
  accounts: AccountsRepo;
  transactions: TransactionsRepo;
  syncJobs: SyncJobsRepo;
  rates: RatesRepo;
}

export function createRepositories(db: Db): Repositories {
  return {
    sessions: new SessionsRepo(db),
    connections: new ConnectionsRepo(db),
    accounts: new AccountsRepo(db),
    transactions: new TransactionsRepo(db),
    syncJobs: new SyncJobsRepo(db),
    rates: new RatesRepo(db),
  };
}
