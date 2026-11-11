import type { Category } from '@ledger-lens/contracts';
import type { FopRecord } from '@api/domain/fop-report';
import type { UkrsibRow } from '@api/domain/ukrsib-statement';
import type { ProviderAccount, RatePair } from '@api/providers/port';

export type SqlValue = string | number | null;

/**
 * As much of a SQLite database as the app uses. On the phone it is expo-sqlite (`platform/sqlite.ts`); in the tests it
 * is Node's own SQLite, so the SQL below is run for real before it ever reaches a phone.
 */
export interface SqlDb {
  exec(sql: string): Promise<void>;
  run(sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }>;
  all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  transaction(task: () => Promise<void>): Promise<void>;
}

/** Additive only: the phone holds the person's history, and an update must never lose it. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE accounts (
     id TEXT PRIMARY KEY, kind TEXT NOT NULL, card_type TEXT NOT NULL, name TEXT NOT NULL, currency TEXT NOT NULL,
     last4 TEXT, credit_limit_minor INTEGER NOT NULL, balance_minor INTEGER NOT NULL, goal_minor INTEGER,
     sort INTEGER NOT NULL
   );
   CREATE TABLE transactions (
     id TEXT PRIMARY KEY, account_id TEXT NOT NULL, ts INTEGER NOT NULL, status TEXT NOT NULL,
     amount_minor INTEGER NOT NULL, currency TEXT NOT NULL, description TEXT NOT NULL, counterparty TEXT,
     comment TEXT, mcc INTEGER, category TEXT NOT NULL, search TEXT NOT NULL
   );
   CREATE INDEX transactions_ts ON transactions (ts DESC);
   CREATE TABLE windows (
     id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, day_from TEXT NOT NULL, day_to TEXT NOT NULL,
     priority INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE fop_rows (
     id TEXT PRIMARY KEY, ts INTEGER NOT NULL, day TEXT NOT NULL, account TEXT NOT NULL, currency TEXT NOT NULL,
     direction TEXT NOT NULL, amount_minor INTEGER NOT NULL, uah_minor INTEGER, counterparty TEXT NOT NULL,
     purpose TEXT NOT NULL, kind TEXT NOT NULL, override INTEGER
   );`,
];

export interface TransactionRow {
  id: string;
  accountId: string;
  /** Unix milliseconds. */
  ts: number;
  status: 'pending' | 'booked';
  /** In the account's currency; negative is money out. Integer minor units. */
  amountMinor: number;
  currency: string;
  description: string;
  counterparty: string | null;
  comment: string | null;
  mcc: number | null;
  category: Category;
}

export interface StatementWindow {
  id: number;
  accountId: string;
  from: string;
  to: string;
}

/** What the person searches by, lower-cased here because SQLite only lower-cases Latin letters. */
export const searchText = (row: Pick<TransactionRow, 'description' | 'counterparty' | 'comment'>) =>
  `${row.description} ${row.counterparty ?? ''} ${row.comment ?? ''}`.toLowerCase();

const escapeLike = (text: string): string => text.replace(/[\\%_]/g, (char) => `\\${char}`);

interface AccountSql {
  id: string;
  kind: 'card' | 'jar';
  card_type: string;
  name: string;
  currency: string;
  last4: string | null;
  credit_limit_minor: number;
  balance_minor: number;
  goal_minor: number | null;
  sort: number;
}
interface TransactionSql {
  id: string;
  account_id: string;
  ts: number;
  status: 'pending' | 'booked';
  amount_minor: number;
  currency: string;
  description: string;
  counterparty: string | null;
  comment: string | null;
  mcc: number | null;
  category: Category;
}
interface FopSql {
  id: string;
  ts: number;
  day: string;
  account: string;
  currency: string;
  direction: 'in' | 'out';
  amount_minor: number;
  uah_minor: number | null;
  counterparty: string;
  purpose: string;
  kind: FopRecord['kind'];
  override: number | null;
}

/**
 * Everything the app keeps on the phone, except the bank token (that is the Keychain's). Plain data in the app's own
 * folder, which iOS keeps from other apps: the history is not encrypted by this app and is never described as such.
 */
export class Store {
  private constructor(private readonly db: SqlDb) {}

  static async open(db: SqlDb): Promise<Store> {
    await db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const rows = await db.all<{ version: number }>('SELECT version FROM schema_version');
    let version = rows[0]?.version ?? 0;
    if (rows.length === 0) await db.run('INSERT INTO schema_version (version) VALUES (0)');
    for (; version < MIGRATIONS.length; version++) {
      const sql = MIGRATIONS[version] ?? '';
      const next = version + 1;
      await db.transaction(async () => {
        await db.exec(sql);
        await db.run('UPDATE schema_version SET version = ?', [next]);
      });
    }
    return new Store(db);
  }

  // ------------------------------------------------------------------------------------------- meta

  async meta(key: string): Promise<string | null> {
    const rows = await this.db.all<{ value: string }>('SELECT value FROM meta WHERE key = ?', [
      key,
    ]);
    return rows[0]?.value ?? null;
  }

  async setMeta(key: string, value: string | null): Promise<void> {
    if (value === null) await this.db.run('DELETE FROM meta WHERE key = ?', [key]);
    else {
      await this.db.run(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        [key, value],
      );
    }
  }

  async rates(): Promise<RatePair[]> {
    const text = await this.meta('rates');
    return text ? (JSON.parse(text) as RatePair[]) : [];
  }

  // ------------------------------------------------------------------------------------------- accounts

  async accounts(): Promise<ProviderAccount[]> {
    const rows = await this.db.all<AccountSql>('SELECT * FROM accounts ORDER BY sort, id');
    return rows.map((row) => ({
      providerAccountId: row.id,
      kind: row.kind,
      cardType: row.card_type,
      name: row.name,
      currency: row.currency,
      last4: row.last4,
      creditLimitMinor: row.credit_limit_minor,
      balanceMinor: row.balance_minor,
      goalMinor: row.goal_minor,
      sort: row.sort,
    }));
  }

  /** The bank's list replaces ours: an account the bank no longer reports goes, with its rows and its queue. */
  async replaceAccounts(accounts: readonly ProviderAccount[]): Promise<void> {
    await this.db.transaction(async () => {
      const keep = new Set(accounts.map((a) => a.providerAccountId));
      for (const { id } of await this.db.all<{ id: string }>('SELECT id FROM accounts')) {
        if (keep.has(id)) continue;
        await this.db.run('DELETE FROM transactions WHERE account_id = ?', [id]);
        await this.db.run('DELETE FROM windows WHERE account_id = ?', [id]);
        await this.db.run('DELETE FROM accounts WHERE id = ?', [id]);
      }
      for (const a of accounts) {
        await this.db.run(
          `INSERT INTO accounts (id, kind, card_type, name, currency, last4, credit_limit_minor, balance_minor, goal_minor, sort)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, card_type = excluded.card_type, name = excluded.name,
             currency = excluded.currency, last4 = excluded.last4, credit_limit_minor = excluded.credit_limit_minor,
             balance_minor = excluded.balance_minor, goal_minor = excluded.goal_minor, sort = excluded.sort`,
          [
            a.providerAccountId,
            a.kind,
            a.cardType,
            a.name,
            a.currency,
            a.last4,
            a.creditLimitMinor,
            a.balanceMinor,
            a.goalMinor,
            a.sort,
          ],
        );
      }
    });
  }

  // ------------------------------------------------------------------------------------------- transactions

  /** New rows are added and known ones brought up to date (a hold becomes booked). Returns how many were new. */
  async upsertTransactions(rows: readonly TransactionRow[]): Promise<number> {
    let added = 0;
    await this.db.transaction(async () => {
      for (const row of rows) {
        const had = await this.db.all<{ id: string }>('SELECT id FROM transactions WHERE id = ?', [
          row.id,
        ]);
        if (had.length === 0) added += 1;
        await this.db.run(
          `INSERT INTO transactions (id, account_id, ts, status, amount_minor, currency, description, counterparty, comment, mcc, category, search)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET ts = excluded.ts, status = excluded.status, amount_minor = excluded.amount_minor,
             currency = excluded.currency, description = excluded.description, counterparty = excluded.counterparty,
             comment = excluded.comment, mcc = excluded.mcc, category = excluded.category, search = excluded.search`,
          [
            row.id,
            row.accountId,
            row.ts,
            row.status,
            row.amountMinor,
            row.currency,
            row.description,
            row.counterparty,
            row.comment,
            row.mcc,
            row.category,
            searchText(row),
          ],
        );
      }
    });
    return added;
  }

  /** Newest first. Every word of the query has to be somewhere in the description, the counterparty or the note. */
  async transactions(query: string, limit: number): Promise<TransactionRow[]> {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    const where = words.map(() => "search LIKE ? ESCAPE '\\'").join(' AND ');
    const rows = await this.db.all<TransactionSql>(
      `SELECT * FROM transactions ${where ? `WHERE ${where}` : ''} ORDER BY ts DESC, id DESC LIMIT ?`,
      [...words.map((word) => `%${escapeLike(word)}%`), limit],
    );
    return rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      ts: row.ts,
      status: row.status,
      amountMinor: row.amount_minor,
      currency: row.currency,
      description: row.description,
      counterparty: row.counterparty,
      comment: row.comment,
      mcc: row.mcc,
      category: row.category,
    }));
  }

  async transactionCount(): Promise<number> {
    const rows = await this.db.all<{ n: number }>('SELECT COUNT(*) AS n FROM transactions');
    return rows[0]?.n ?? 0;
  }

  // ------------------------------------------------------------------------------------------- statement windows

  async addWindow(accountId: string, from: string, to: string, priority: number): Promise<void> {
    await this.db.run(
      'INSERT INTO windows (account_id, day_from, day_to, priority) VALUES (?, ?, ?, ?)',
      [accountId, from, to, priority],
    );
  }

  /** The next statement to read: the lowest priority number first, then the order it was queued in. */
  async nextWindow(): Promise<StatementWindow | null> {
    const rows = await this.db.all<{
      id: number;
      account_id: string;
      day_from: string;
      day_to: string;
    }>('SELECT * FROM windows WHERE done = 0 ORDER BY priority, id LIMIT 1');
    const row = rows[0];
    return row
      ? { id: row.id, accountId: row.account_id, from: row.day_from, to: row.day_to }
      : null;
  }

  async finishWindow(id: number): Promise<void> {
    await this.db.run('UPDATE windows SET done = 1 WHERE id = ?', [id]);
  }

  async dropFinishedWindows(): Promise<void> {
    await this.db.run('DELETE FROM windows WHERE done = 1');
  }

  async windowCounts(): Promise<{ done: number; total: number }> {
    const rows = await this.db.all<{ done: number | null; total: number }>(
      'SELECT SUM(done) AS done, COUNT(*) AS total FROM windows',
    );
    return { done: rows[0]?.done ?? 0, total: rows[0]?.total ?? 0 };
  }

  /** Disconnecting: the bank's data goes; the ФОП rows are the person's own files and stay. */
  async clearBank(): Promise<void> {
    await this.db.transaction(async () => {
      await this.db.exec('DELETE FROM transactions; DELETE FROM windows; DELETE FROM accounts;');
      await this.db.run("DELETE FROM meta WHERE key <> 'fopRate'");
    });
  }

  // ------------------------------------------------------------------------------------------- ФОП rows

  /** Rows keep their id across imports of overlapping periods, and the person's own counted or not is kept. */
  async upsertFopRows(rows: readonly UkrsibRow[]): Promise<number> {
    let added = 0;
    await this.db.transaction(async () => {
      for (const row of rows) {
        const had = await this.db.all<{ id: string }>('SELECT id FROM fop_rows WHERE id = ?', [
          row.id,
        ]);
        if (had.length === 0) added += 1;
        await this.db.run(
          `INSERT INTO fop_rows (id, ts, day, account, currency, direction, amount_minor, uah_minor, counterparty, purpose, kind)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET ts = excluded.ts, day = excluded.day, account = excluded.account,
             currency = excluded.currency, direction = excluded.direction, amount_minor = excluded.amount_minor,
             uah_minor = excluded.uah_minor, counterparty = excluded.counterparty, purpose = excluded.purpose,
             kind = excluded.kind`,
          [
            row.id,
            row.ts,
            row.day,
            row.account,
            row.currency,
            row.direction,
            row.amountMinor,
            row.uahMinor,
            row.counterparty,
            row.purpose,
            row.kind,
          ],
        );
      }
    });
    return added;
  }

  async fopRows(): Promise<FopRecord[]> {
    const rows = await this.db.all<FopSql>('SELECT * FROM fop_rows ORDER BY ts DESC, id');
    return rows.map((row) => ({
      id: row.id,
      ts: row.ts,
      day: row.day,
      account: row.account,
      currency: row.currency,
      direction: row.direction,
      amountMinor: row.amount_minor,
      uahMinor: row.uah_minor,
      counterparty: row.counterparty,
      purpose: row.purpose,
      kind: row.kind,
      override: row.override === null ? null : row.override === 1,
    }));
  }

  async setFopOverride(id: string, counted: boolean | null): Promise<void> {
    await this.db.run('UPDATE fop_rows SET override = ? WHERE id = ?', [
      counted === null ? null : counted ? 1 : 0,
      id,
    ]);
  }

  async clearFop(): Promise<void> {
    await this.db.run('DELETE FROM fop_rows');
  }
}
