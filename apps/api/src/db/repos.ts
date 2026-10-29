import type {
  AccountType,
  Category,
  ConnectionStatus,
  PaymentFailureReason,
  PaymentHistoryEntry,
  PaymentStatus,
  Permission,
  ProviderId,
  TransactionQuery,
  TransactionStatus,
} from '@ledger-lens/contracts';
import { newId } from '../domain/crypto';
import type { Db, SqlParam } from './database';

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

  /** Deletes the session and, through ON DELETE CASCADE, every connection, account and transaction under it. */
  delete(id: string): void {
    this.db.run('DELETE FROM sessions WHERE id = ?', id);
  }

  purgeIdleBefore(iso: string): number {
    return this.db.run('DELETE FROM sessions WHERE last_seen_at < ?', iso).changes;
  }
}

// ============================================================================================= connections

export interface ConnectionRecord {
  id: string;
  sessionId: string;
  provider: ProviderId;
  institutionId: string;
  institutionName: string;
  institutionLogoUrl: string | null;
  status: ConnectionStatus;
  state: string | null;
  stateExpiresAt: string | null;
  codeVerifierEnc: string | null;
  tokensEnc: string | null;
  tokenExpiresAt: string | null;
  permissions: Permission[];
  consentExpiresAt: string | null;
  lastRefreshedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ConnectionRow {
  id: string;
  session_id: string;
  provider: string;
  institution_id: string;
  institution_name: string;
  institution_logo_url: string | null;
  status: string;
  state: string | null;
  state_expires_at: string | null;
  code_verifier_enc: string | null;
  tokens_enc: string | null;
  token_expires_at: string | null;
  permissions: string;
  consent_expires_at: string | null;
  last_refreshed_at: string | null;
  created_at: string;
  updated_at: string;
}

const toConnection = (row: ConnectionRow): ConnectionRecord => ({
  id: row.id,
  sessionId: row.session_id,
  provider: row.provider as ProviderId,
  institutionId: row.institution_id,
  institutionName: row.institution_name,
  institutionLogoUrl: row.institution_logo_url,
  status: row.status as ConnectionStatus,
  state: row.state,
  stateExpiresAt: row.state_expires_at,
  codeVerifierEnc: row.code_verifier_enc,
  tokensEnc: row.tokens_enc,
  tokenExpiresAt: row.token_expires_at,
  permissions: JSON.parse(row.permissions) as Permission[],
  consentExpiresAt: row.consent_expires_at,
  lastRefreshedAt: row.last_refreshed_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export type ConnectionPatch = Partial<
  Pick<
    ConnectionRecord,
    | 'status'
    | 'state'
    | 'stateExpiresAt'
    | 'codeVerifierEnc'
    | 'tokensEnc'
    | 'tokenExpiresAt'
    | 'permissions'
    | 'consentExpiresAt'
    | 'lastRefreshedAt'
    | 'institutionName'
    | 'institutionLogoUrl'
  >
>;

const CONNECTION_COLUMNS: Record<keyof ConnectionPatch, string> = {
  status: 'status',
  state: 'state',
  stateExpiresAt: 'state_expires_at',
  codeVerifierEnc: 'code_verifier_enc',
  tokensEnc: 'tokens_enc',
  tokenExpiresAt: 'token_expires_at',
  permissions: 'permissions',
  consentExpiresAt: 'consent_expires_at',
  lastRefreshedAt: 'last_refreshed_at',
  institutionName: 'institution_name',
  institutionLogoUrl: 'institution_logo_url',
};

export interface NewPendingConnection {
  id: string;
  sessionId: string;
  provider: ProviderId;
  institutionId: string;
  institutionName: string;
  institutionLogoUrl: string | null;
  state: string;
  stateExpiresAt: string;
  codeVerifierEnc: string;
  now: string;
}

export class ConnectionsRepo {
  constructor(private readonly db: Db) {}

  insertPending(input: NewPendingConnection): void {
    this.db.run(
      `INSERT INTO connections (id, session_id, provider, institution_id, institution_name, institution_logo_url, status,
         state, state_expires_at, code_verifier_enc, permissions, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, '[]', ?, ?)`,
      input.id,
      input.sessionId,
      input.provider,
      input.institutionId,
      input.institutionName,
      input.institutionLogoUrl,
      input.state,
      input.stateExpiresAt,
      input.codeVerifierEnc,
      input.now,
      input.now,
    );
  }

  /** Token-based banks have no consent redirect: the connection is active as soon as the token has been checked. */
  insertActive(input: {
    id: string;
    sessionId: string;
    provider: ProviderId;
    institutionId: string;
    institutionName: string;
    institutionLogoUrl: string | null;
    tokensEnc: string;
    tokenExpiresAt: string;
    permissions: Permission[];
    consentExpiresAt: string | null;
    now: string;
  }): void {
    this.db.run(
      `INSERT INTO connections (id, session_id, provider, institution_id, institution_name, institution_logo_url, status,
         tokens_enc, token_expires_at, permissions, consent_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.sessionId,
      input.provider,
      input.institutionId,
      input.institutionName,
      input.institutionLogoUrl,
      input.tokensEnc,
      input.tokenExpiresAt,
      JSON.stringify(input.permissions),
      input.consentExpiresAt,
      input.now,
      input.now,
    );
  }

  findById(id: string): ConnectionRecord | undefined {
    const row = this.db.get<ConnectionRow>('SELECT * FROM connections WHERE id = ?', id);
    return row ? toConnection(row) : undefined;
  }

  findForSession(sessionId: string, id: string): ConnectionRecord | undefined {
    const row = this.db.get<ConnectionRow>(
      'SELECT * FROM connections WHERE id = ? AND session_id = ?',
      id,
      sessionId,
    );
    return row ? toConnection(row) : undefined;
  }

  findByState(state: string): ConnectionRecord | undefined {
    const row = this.db.get<ConnectionRow>('SELECT * FROM connections WHERE state = ?', state);
    return row ? toConnection(row) : undefined;
  }

  listBySession(sessionId: string): ConnectionRecord[] {
    return this.db
      .all<ConnectionRow>(
        `SELECT * FROM connections WHERE session_id = ? AND NOT (status = 'pending' AND state IS NOT NULL) ORDER BY created_at ASC`,
        sessionId,
      )
      .map(toConnection);
  }

  update(id: string, patch: ConnectionPatch, now: string): void {
    const sets: string[] = [];
    const params: SqlParam[] = [];
    for (const [key, value] of Object.entries(patch) as [keyof ConnectionPatch, unknown][]) {
      sets.push(`${CONNECTION_COLUMNS[key]} = ?`);
      params.push((key === 'permissions' ? JSON.stringify(value) : (value ?? null)) as SqlParam);
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

  /** Abandoned consent redirects (the user never came back) are not worth keeping. */
  deleteAbandoned(sessionId: string, before: string): number {
    return this.db.run(
      `DELETE FROM connections WHERE session_id = ? AND status = 'pending' AND state_expires_at < ?`,
      sessionId,
      before,
    ).changes;
  }

  accountCount(connectionId: string): number {
    return (
      this.db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM accounts WHERE connection_id = ?',
        connectionId,
      )?.n ?? 0
    );
  }
}

// ================================================================================================= accounts

export interface AccountRecord {
  id: string;
  connectionId: string;
  providerAccountId: string;
  name: string;
  type: AccountType;
  currency: string;
  maskedIdentifier: string | null;
  balanceMinor: number;
  availableMinor: number | null;
  balanceAt: string;
  lastRefreshedAt: string;
}

export interface AccountWithConnection extends AccountRecord {
  sessionId: string;
  institutionId: string;
  institutionName: string;
}

interface AccountRow {
  id: string;
  connection_id: string;
  provider_account_id: string;
  name: string;
  type: string;
  currency: string;
  masked_identifier: string | null;
  balance_minor: number;
  available_minor: number | null;
  balance_at: string;
  last_refreshed_at: string;
}

interface AccountJoinRow extends AccountRow {
  session_id: string;
  institution_id: string;
  institution_name: string;
}

const toAccount = (row: AccountRow): AccountRecord => ({
  id: row.id,
  connectionId: row.connection_id,
  providerAccountId: row.provider_account_id,
  name: row.name,
  type: row.type as AccountType,
  currency: row.currency,
  maskedIdentifier: row.masked_identifier,
  balanceMinor: row.balance_minor,
  availableMinor: row.available_minor,
  balanceAt: row.balance_at,
  lastRefreshedAt: row.last_refreshed_at,
});

const toAccountJoin = (row: AccountJoinRow): AccountWithConnection => ({
  ...toAccount(row),
  sessionId: row.session_id,
  institutionId: row.institution_id,
  institutionName: row.institution_name,
});

export interface AccountUpsert {
  providerAccountId: string;
  name: string;
  type: AccountType;
  currency: string;
  maskedIdentifier: string | null;
  balanceMinor: number;
  availableMinor: number | null;
  balanceAt: string;
  now: string;
}

const ACCOUNT_JOIN = `SELECT a.*, c.session_id, c.institution_id, c.institution_name
  FROM accounts a JOIN connections c ON c.id = a.connection_id`;

export class AccountsRepo {
  constructor(private readonly db: Db) {}

  upsert(connectionId: string, input: AccountUpsert): AccountRecord {
    const existing = this.db.get<AccountRow>(
      'SELECT * FROM accounts WHERE connection_id = ? AND provider_account_id = ?',
      connectionId,
      input.providerAccountId,
    );
    if (existing) {
      this.db.run(
        `UPDATE accounts SET name = ?, type = ?, currency = ?, masked_identifier = ?, balance_minor = ?,
           available_minor = ?, balance_at = ?, last_refreshed_at = ? WHERE id = ?`,
        input.name,
        input.type,
        input.currency,
        input.maskedIdentifier,
        input.balanceMinor,
        input.availableMinor,
        input.balanceAt,
        input.now,
        existing.id,
      );
      return toAccount({
        ...existing,
        name: input.name,
        type: input.type,
        currency: input.currency,
        masked_identifier: input.maskedIdentifier,
        balance_minor: input.balanceMinor,
        available_minor: input.availableMinor,
        balance_at: input.balanceAt,
        last_refreshed_at: input.now,
      });
    }
    const id = newId('acc');
    this.db.run(
      `INSERT INTO accounts (id, connection_id, provider_account_id, name, type, currency, masked_identifier,
         balance_minor, available_minor, balance_at, last_refreshed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      connectionId,
      input.providerAccountId,
      input.name,
      input.type,
      input.currency,
      input.maskedIdentifier,
      input.balanceMinor,
      input.availableMinor,
      input.balanceAt,
      input.now,
    );
    return {
      id,
      connectionId,
      providerAccountId: input.providerAccountId,
      name: input.name,
      type: input.type,
      currency: input.currency,
      maskedIdentifier: input.maskedIdentifier,
      balanceMinor: input.balanceMinor,
      availableMinor: input.availableMinor,
      balanceAt: input.balanceAt,
      lastRefreshedAt: input.now,
    };
  }

  /** Accounts the bank no longer shares (closed, or removed from the consent) disappear with their history. */
  deleteMissing(connectionId: string, keepProviderIds: readonly string[]): void {
    const existing = this.db.all<{ id: string; provider_account_id: string }>(
      'SELECT id, provider_account_id FROM accounts WHERE connection_id = ?',
      connectionId,
    );
    for (const row of existing) {
      if (!keepProviderIds.includes(row.provider_account_id))
        this.db.run('DELETE FROM accounts WHERE id = ?', row.id);
    }
  }

  findById(id: string): AccountRecord | undefined {
    const row = this.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', id);
    return row ? toAccount(row) : undefined;
  }

  listBySession(sessionId: string): AccountWithConnection[] {
    return this.db
      .all<AccountJoinRow>(
        `${ACCOUNT_JOIN} WHERE c.session_id = ? ORDER BY c.created_at, a.name`,
        sessionId,
      )
      .map(toAccountJoin);
  }

  listByConnection(connectionId: string): AccountRecord[] {
    return this.db
      .all<AccountRow>('SELECT * FROM accounts WHERE connection_id = ? ORDER BY name', connectionId)
      .map(toAccount);
  }

  findForSession(sessionId: string, accountId: string): AccountWithConnection | undefined {
    const row = this.db.get<AccountJoinRow>(
      `${ACCOUNT_JOIN} WHERE c.session_id = ? AND a.id = ?`,
      sessionId,
      accountId,
    );
    return row ? toAccountJoin(row) : undefined;
  }
}

// ============================================================================================ transactions

export interface TransactionRecord {
  id: string;
  accountId: string;
  providerTxnId: string;
  bookedAt: string;
  status: TransactionStatus;
  amountMinor: number;
  currency: string;
  description: string;
  counterparty: string | null;
  category: Category;
  categorySource: 'auto' | 'user';
}

interface TransactionRow {
  id: string;
  account_id: string;
  provider_txn_id: string;
  booked_at: string;
  status: string;
  amount_minor: number;
  currency: string;
  description: string;
  counterparty: string | null;
  category: string;
  category_source: string;
}

const toTransaction = (row: TransactionRow): TransactionRecord => ({
  id: row.id,
  accountId: row.account_id,
  providerTxnId: row.provider_txn_id,
  bookedAt: row.booked_at,
  status: row.status as TransactionStatus,
  amountMinor: row.amount_minor,
  currency: row.currency,
  description: row.description,
  counterparty: row.counterparty,
  category: row.category as Category,
  categorySource: row.category_source as 'auto' | 'user',
});

export interface NewTransaction {
  providerTxnId: string;
  bookedAt: string;
  amountMinor: number;
  currency: string;
  description: string;
  counterparty: string | null;
  category: Category;
}

export interface TransactionPageResult {
  items: TransactionRecord[];
  nextCursor: string | null;
  total: number;
}

const encodeCursor = (record: Pick<TransactionRecord, 'bookedAt' | 'id'>): string =>
  Buffer.from(JSON.stringify([record.bookedAt, record.id]), 'utf8').toString('base64url');

function decodeCursor(cursor: string): [string, string] | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') {
      return [parsed[0], parsed[1]];
    }
  } catch {
    // fall through
  }
  return null;
}

const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (c) => `\\${c}`);

export class TransactionsRepo {
  constructor(private readonly db: Db) {}

  /**
   * Inserts new booked rows and updates existing ones in place. A category the user chose is never overwritten.
   * Returns how many rows were new.
   */
  upsertBooked(accountId: string, rows: readonly NewTransaction[]): number {
    const countBefore = this.countForAccount(accountId);
    this.db.transaction(() => {
      for (const row of rows) {
        this.db.run(
          `INSERT INTO transactions (id, account_id, provider_txn_id, booked_at, status, amount_minor, currency,
             description, counterparty, category, category_source)
           VALUES (?, ?, ?, ?, 'booked', ?, ?, ?, ?, ?, 'auto')
           ON CONFLICT (account_id, provider_txn_id) DO UPDATE SET
             booked_at = excluded.booked_at, status = 'booked', amount_minor = excluded.amount_minor,
             description = excluded.description, counterparty = excluded.counterparty,
             category = CASE WHEN transactions.category_source = 'user' THEN transactions.category ELSE excluded.category END`,
          newId('txn'),
          accountId,
          row.providerTxnId,
          row.bookedAt,
          row.amountMinor,
          row.currency,
          row.description,
          row.counterparty,
          row.category,
        );
      }
    });
    return this.countForAccount(accountId) - countBefore;
  }

  /** The pending set from the bank is authoritative: drop what we had and store what it reports now. */
  replacePending(accountId: string, rows: readonly NewTransaction[]): void {
    this.db.transaction(() => {
      this.db.run(
        `DELETE FROM transactions WHERE account_id = ? AND status = 'pending'`,
        accountId,
      );
      for (const row of rows) {
        this.db.run(
          `INSERT OR IGNORE INTO transactions (id, account_id, provider_txn_id, booked_at, status, amount_minor, currency,
             description, counterparty, category, category_source)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, 'auto')`,
          newId('txn'),
          accountId,
          row.providerTxnId,
          row.bookedAt,
          row.amountMinor,
          row.currency,
          row.description,
          row.counterparty,
          row.category,
        );
      }
    });
  }

  countForAccount(accountId: string): number {
    return (
      this.db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM transactions WHERE account_id = ?',
        accountId,
      )?.n ?? 0
    );
  }

  latestBookedAt(accountId: string): string | undefined {
    return (
      this.db.get<{ booked_at: string | null }>(
        `SELECT MAX(booked_at) AS booked_at FROM transactions WHERE account_id = ? AND status = 'booked'`,
        accountId,
      )?.booked_at ?? undefined
    );
  }

  findForSession(sessionId: string, id: string): TransactionRecord | undefined {
    const row = this.db.get<TransactionRow>(
      `SELECT t.* FROM transactions t JOIN accounts a ON a.id = t.account_id JOIN connections c ON c.id = a.connection_id
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

  /** Every transaction in the window for a session; insights are computed from this in memory. */
  listForInsights(sessionId: string, fromIso: string, toIso: string): TransactionRecord[] {
    return this.db
      .all<TransactionRow>(
        `SELECT t.* FROM transactions t JOIN accounts a ON a.id = t.account_id JOIN connections c ON c.id = a.connection_id
         WHERE c.session_id = ? AND t.booked_at >= ? AND t.booked_at <= ? AND t.status = 'booked'
         ORDER BY t.booked_at ASC, t.id ASC`,
        sessionId,
        fromIso,
        toIso,
      )
      .map(toTransaction);
  }

  list(sessionId: string, query: TransactionQuery): TransactionPageResult {
    const where: string[] = ['c.session_id = ?'];
    const params: SqlParam[] = [sessionId];

    if (query.accountId) {
      where.push('t.account_id = ?');
      params.push(query.accountId);
    }
    if (query.from) {
      where.push('t.booked_at >= ?');
      params.push(`${query.from}T00:00:00.000Z`);
    }
    if (query.to) {
      where.push('t.booked_at <= ?');
      params.push(`${query.to}T23:59:59.999Z`);
    }
    if (query.q) {
      const like = `%${escapeLike(query.q.toLowerCase())}%`;
      where.push(
        `(LOWER(t.description) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(t.counterparty, '')) LIKE ? ESCAPE '\\')`,
      );
      params.push(like, like);
    }
    if (query.category) {
      where.push('t.category = ?');
      params.push(query.category);
    }
    if (query.status) {
      where.push('t.status = ?');
      params.push(query.status);
    }
    if (query.direction === 'in') where.push('t.amount_minor > 0');
    if (query.direction === 'out') where.push('t.amount_minor < 0');
    if (query.minAmountMinor !== undefined) {
      where.push('ABS(t.amount_minor) >= ?');
      params.push(query.minAmountMinor);
    }
    if (query.maxAmountMinor !== undefined) {
      where.push('ABS(t.amount_minor) <= ?');
      params.push(query.maxAmountMinor);
    }

    const from = `FROM transactions t JOIN accounts a ON a.id = t.account_id JOIN connections c ON c.id = a.connection_id`;
    const total =
      this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n ${from} WHERE ${where.join(' AND ')}`,
        ...params,
      )?.n ?? 0;

    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const pageWhere = [...where];
    const pageParams = [...params];
    if (cursor) {
      pageWhere.push('(t.booked_at < ? OR (t.booked_at = ? AND t.id < ?))');
      pageParams.push(cursor[0], cursor[0], cursor[1]);
    }
    const rows = this.db
      .all<TransactionRow>(
        `SELECT t.* ${from} WHERE ${pageWhere.join(' AND ')} ORDER BY t.booked_at DESC, t.id DESC LIMIT ?`,
        ...pageParams,
        query.limit + 1,
      )
      .map(toTransaction);

    const items = rows.slice(0, query.limit);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null,
      total,
    };
  }
}

// ============================================================================================== sync jobs

export interface SyncJobRecord {
  id: string;
  connectionId: string;
  accountId: string;
  from: string;
  to: string;
  seq: number;
  attempts: number;
}

interface SyncJobRow {
  id: string;
  connection_id: string;
  account_id: string;
  window_from: string;
  window_to: string;
  seq: number;
  attempts: number;
}

/** Queue of paced transaction reads. Rows survive a restart, so a long history load resumes where it stopped. */
export class SyncJobsRepo {
  constructor(private readonly db: Db) {}

  enqueue(
    input: { connectionId: string; accountId: string; from: string; to: string; seq: number },
    now: string,
  ): void {
    this.db.run(
      `INSERT INTO sync_jobs (id, connection_id, account_id, window_from, window_to, seq, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      newId('job'),
      input.connectionId,
      input.accountId,
      input.from,
      input.to,
      input.seq,
      now,
      now,
    );
  }

  next(connectionId: string): SyncJobRecord | undefined {
    const row = this.db.get<SyncJobRow>(
      `SELECT id, connection_id, account_id, window_from, window_to, seq, attempts FROM sync_jobs
       WHERE connection_id = ? AND status = 'pending' ORDER BY seq ASC, created_at ASC, id ASC LIMIT 1`,
      connectionId,
    );
    return row
      ? {
          id: row.id,
          connectionId: row.connection_id,
          accountId: row.account_id,
          from: row.window_from,
          to: row.window_to,
          seq: row.seq,
          attempts: row.attempts,
        }
      : undefined;
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

  /** A failed attempt: stays pending until `maxAttempts`, then gives up so the queue cannot stall forever. */
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

  /** Null when nothing is left to load, so the UI shows a banner only while there is something to wait for. */
  progress(connectionId: string): { done: number; total: number } | null {
    const row = this.db.get<{ total: number; done: number }>(
      `SELECT COUNT(*) AS total, COALESCE(SUM(status <> 'pending'), 0) AS done FROM sync_jobs WHERE connection_id = ?`,
      connectionId,
    );
    if (!row || row.total === 0 || row.done >= row.total) return null;
    return { done: row.done, total: row.total };
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

// ================================================================================================= payments

export interface PaymentRecord {
  id: string;
  sessionId: string;
  provider: ProviderId;
  institutionId: string;
  institutionName: string;
  idempotencyKey: string;
  requestHash: string;
  providerIdempotencyKey: string;
  /** Null until the provider has accepted the payment; such a row is invisible to the customer. */
  providerPaymentId: string | null;
  amountMinor: number;
  currency: string;
  beneficiaryName: string;
  beneficiaryIdentifier: string;
  reference: string;
  status: PaymentStatus;
  settlementExpected: boolean;
  failureReason: PaymentFailureReason | null;
  statusHistory: PaymentHistoryEntry[];
  authUrlEnc: string | null;
  createdAt: string;
  updatedAt: string;
  lastCheckedAt: string | null;
}

interface PaymentRow {
  id: string;
  session_id: string;
  provider: string;
  institution_id: string;
  institution_name: string;
  idempotency_key: string;
  request_hash: string;
  provider_idempotency_key: string;
  provider_payment_id: string | null;
  amount_minor: number;
  currency: string;
  beneficiary_name: string;
  beneficiary_identifier: string;
  reference: string;
  status: string;
  settlement_expected: number;
  failure_reason: string | null;
  status_history: string;
  auth_url_enc: string | null;
  created_at: string;
  updated_at: string;
  last_checked_at: string | null;
}

const toPayment = (row: PaymentRow): PaymentRecord => ({
  id: row.id,
  sessionId: row.session_id,
  provider: row.provider as ProviderId,
  institutionId: row.institution_id,
  institutionName: row.institution_name,
  idempotencyKey: row.idempotency_key,
  requestHash: row.request_hash,
  providerIdempotencyKey: row.provider_idempotency_key,
  providerPaymentId: row.provider_payment_id,
  amountMinor: row.amount_minor,
  currency: row.currency,
  beneficiaryName: row.beneficiary_name,
  beneficiaryIdentifier: row.beneficiary_identifier,
  reference: row.reference,
  status: row.status as PaymentStatus,
  settlementExpected: row.settlement_expected === 1,
  failureReason: row.failure_reason as PaymentFailureReason | null,
  statusHistory: JSON.parse(row.status_history) as PaymentHistoryEntry[],
  authUrlEnc: row.auth_url_enc,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastCheckedAt: row.last_checked_at,
});

export type PaymentPatch = Partial<
  Pick<
    PaymentRecord,
    | 'providerPaymentId'
    | 'status'
    | 'settlementExpected'
    | 'failureReason'
    | 'statusHistory'
    | 'authUrlEnc'
    | 'lastCheckedAt'
  >
>;

const PAYMENT_COLUMNS: Record<keyof PaymentPatch, string> = {
  providerPaymentId: 'provider_payment_id',
  status: 'status',
  settlementExpected: 'settlement_expected',
  failureReason: 'failure_reason',
  statusHistory: 'status_history',
  authUrlEnc: 'auth_url_enc',
  lastCheckedAt: 'last_checked_at',
};

/** A payment with nothing left to wait for: failed, cancelled, settled, or executed where no settlement follows. */
const NOT_FINAL = `(status IN ('pending','authorised') OR (status = 'executed' AND settlement_expected = 1))`;

export class PaymentsRepo {
  constructor(private readonly db: Db) {}

  insert(record: PaymentRecord): void {
    this.db.run(
      `INSERT INTO payments (id, session_id, provider, institution_id, institution_name, idempotency_key, request_hash,
         provider_idempotency_key, provider_payment_id, amount_minor, currency, beneficiary_name, beneficiary_identifier,
         reference, status, settlement_expected, failure_reason, status_history, auth_url_enc, created_at, updated_at,
         last_checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      record.sessionId,
      record.provider,
      record.institutionId,
      record.institutionName,
      record.idempotencyKey,
      record.requestHash,
      record.providerIdempotencyKey,
      record.providerPaymentId,
      record.amountMinor,
      record.currency,
      record.beneficiaryName,
      record.beneficiaryIdentifier,
      record.reference,
      record.status,
      record.settlementExpected ? 1 : 0,
      record.failureReason,
      JSON.stringify(record.statusHistory),
      record.authUrlEnc,
      record.createdAt,
      record.updatedAt,
      record.lastCheckedAt,
    );
  }

  /** Only payments the provider has accepted: an attempt that never reached it is not a payment yet. */
  findForSession(sessionId: string, id: string): PaymentRecord | undefined {
    const row = this.db.get<PaymentRow>(
      'SELECT * FROM payments WHERE session_id = ? AND id = ? AND provider_payment_id IS NOT NULL',
      sessionId,
      id,
    );
    return row ? toPayment(row) : undefined;
  }

  findById(id: string): PaymentRecord | undefined {
    const row = this.db.get<PaymentRow>('SELECT * FROM payments WHERE id = ?', id);
    return row ? toPayment(row) : undefined;
  }

  /** Includes attempts that never reached the provider: a retry with the same key completes them. */
  findByIdempotencyKey(sessionId: string, key: string): PaymentRecord | undefined {
    const row = this.db.get<PaymentRow>(
      'SELECT * FROM payments WHERE session_id = ? AND idempotency_key = ?',
      sessionId,
      key,
    );
    return row ? toPayment(row) : undefined;
  }

  findByProviderPaymentId(
    providerPaymentId: string,
    provider?: ProviderId,
  ): PaymentRecord | undefined {
    const row = provider
      ? this.db.get<PaymentRow>(
          'SELECT * FROM payments WHERE provider = ? AND provider_payment_id = ?',
          provider,
          providerPaymentId,
        )
      : this.db.get<PaymentRow>(
          'SELECT * FROM payments WHERE provider_payment_id = ? ORDER BY created_at DESC LIMIT 1',
          providerPaymentId,
        );
    return row ? toPayment(row) : undefined;
  }

  listBySession(sessionId: string): PaymentRecord[] {
    return this.db
      .all<PaymentRow>(
        'SELECT * FROM payments WHERE session_id = ? AND provider_payment_id IS NOT NULL ORDER BY created_at DESC, id DESC',
        sessionId,
      )
      .map(toPayment);
  }

  update(id: string, patch: PaymentPatch, now: string): void {
    const sets: string[] = [];
    const params: SqlParam[] = [];
    for (const [key, value] of Object.entries(patch) as [keyof PaymentPatch, unknown][]) {
      sets.push(`${PAYMENT_COLUMNS[key]} = ?`);
      if (key === 'statusHistory') params.push(JSON.stringify(value));
      else if (key === 'settlementExpected') params.push(value ? 1 : 0);
      else params.push((value ?? null) as SqlParam);
    }
    if (sets.length === 0) return;
    this.db.run(
      `UPDATE payments SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`,
      ...params,
      now,
      id,
    );
  }

  /** A poll or webhook looked at the payment and found nothing new: remember that without calling it an update. */
  touchChecked(id: string, now: string): void {
    this.db.run('UPDATE payments SET last_checked_at = ? WHERE id = ?', now, id);
  }

  delete(id: string): void {
    this.db.run('DELETE FROM payments WHERE id = ?', id);
  }

  /**
   * Payments the polling fallback should ask the provider about: not final, accepted by the provider, and not touched by
   * a webhook or a poll lately. A payment nobody has checked yet is first looked at after `firstCheckBefore`.
   */
  listDueForPoll(firstCheckBefore: string, recheckBefore: string): PaymentRecord[] {
    return this.db
      .all<PaymentRow>(
        `SELECT * FROM payments WHERE provider_payment_id IS NOT NULL AND ${NOT_FINAL}
           AND ((last_checked_at IS NULL AND created_at <= ?) OR last_checked_at <= ?)
         ORDER BY created_at ASC LIMIT 50`,
        firstCheckBefore,
        recheckBefore,
      )
      .map(toPayment);
  }

  /** Still `pending` since before the cut-off: the customer never finished at the bank. */
  listPendingBefore(before: string): PaymentRecord[] {
    return this.db
      .all<PaymentRow>(
        `SELECT * FROM payments WHERE provider_payment_id IS NOT NULL AND status = 'pending' AND created_at <= ?
         ORDER BY created_at ASC LIMIT 50`,
        before,
      )
      .map(toPayment);
  }

  /** Attempts the provider never acknowledged, abandoned long enough ago that a retry can no longer complete them. */
  deleteUnsentBefore(before: string): number {
    return this.db.run(
      'DELETE FROM payments WHERE provider_payment_id IS NULL AND created_at <= ?',
      before,
    ).changes;
  }
}

// ======================================================================================== webhook events

export interface WebhookEventInput {
  provider: ProviderId;
  eventId: string;
  eventType: string;
  providerPaymentId: string | null;
  /** Redacted JSON text. */
  payload: string;
  receivedAt: string;
  outcome: string;
}

/** The record that makes webhook handling idempotent: the provider's event id can be stored once. */
export class WebhookEventsRepo {
  constructor(private readonly db: Db) {}

  /** False when this event id was already stored, which means the delivery is a duplicate. */
  insert(input: WebhookEventInput): boolean {
    const result = this.db.run(
      `INSERT OR IGNORE INTO webhook_events (id, provider, event_id, event_type, provider_payment_id, payload, received_at, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      newId('whe'),
      input.provider,
      input.eventId,
      input.eventType,
      input.providerPaymentId,
      input.payload,
      input.receivedAt,
      input.outcome,
    );
    return result.changes > 0;
  }

  has(provider: ProviderId, eventId: string): boolean {
    return (
      this.db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM webhook_events WHERE provider = ? AND event_id = ?',
        provider,
        eventId,
      )?.n === 1
    );
  }

  /** Providers stop retrying after a while, so remembering an event for longer than that buys nothing. */
  pruneBefore(before: string): number {
    return this.db.run('DELETE FROM webhook_events WHERE received_at < ?', before).changes;
  }
}

// ============================================================================================ repositories

export interface Repositories {
  sessions: SessionsRepo;
  connections: ConnectionsRepo;
  accounts: AccountsRepo;
  transactions: TransactionsRepo;
  syncJobs: SyncJobsRepo;
  payments: PaymentsRepo;
  webhookEvents: WebhookEventsRepo;
}

export function createRepositories(db: Db): Repositories {
  return {
    sessions: new SessionsRepo(db),
    connections: new ConnectionsRepo(db),
    accounts: new AccountsRepo(db),
    transactions: new TransactionsRepo(db),
    syncJobs: new SyncJobsRepo(db),
    payments: new PaymentsRepo(db),
    webhookEvents: new WebhookEventsRepo(db),
  };
}
