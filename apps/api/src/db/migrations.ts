import type { Db } from './database';

export interface Migration {
  id: string;
  sql: string;
  /**
   * The migration rebuilds a table other tables point at (SQLite cannot drop a UNIQUE or widen a CHECK in place). Foreign keys
   * are switched off around it, as SQLite's own procedure says, because dropping the old table would otherwise cascade into
   * the accounts and transactions. Nothing may be lost: inside the same transaction the row count of every table is compared
   * before and after and the foreign keys are checked, and either one failing rolls everything back.
   */
  rebuild?: boolean;
}

/**
 * Append-only. Migrations are TypeScript string modules rather than .sql files so they survive the esbuild bundle and
 * `tsx` without a loader. Never edit an applied migration; add a new one. (v1's migrations are in the `v1-full-featured` tag.)
 */
export const migrations: Migration[] = [
  {
    id: '001_ledger_lens_v2',
    sql: `
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,            -- SHA-256 of the cookie token, never the token itself
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );

      -- One bank connection per session: replacing the token replaces the row.
      CREATE TABLE connections (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK (provider IN ('monobank','demo')),
        status TEXT NOT NULL CHECK (status IN ('active','needs_reauth','error')),
        tokens_enc TEXT,                         -- sealed JSON, never sent to the browser
        last_refreshed_at TEXT,
        history_months INTEGER NOT NULL DEFAULT 2,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        provider_account_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('card','jar')),
        card_type TEXT NOT NULL,                 -- black, white, platinum, iron, fop, yellow, eAid or jar
        name TEXT NOT NULL,
        currency TEXT NOT NULL,
        last4 TEXT,                              -- the full card number and IBAN are never stored
        credit_limit_minor INTEGER NOT NULL DEFAULT 0,
        balance_minor INTEGER NOT NULL,          -- as the bank reports it: includes the credit limit
        goal_minor INTEGER,
        sort INTEGER NOT NULL DEFAULT 0,
        balance_at TEXT NOT NULL,
        covered_from TEXT,                       -- first day of statement history loaded (inclusive)
        covered_to TEXT,                         -- last day loaded
        last_statement_at TEXT,
        UNIQUE (connection_id, provider_account_id)
      );

      CREATE TABLE transactions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        provider_txn_id TEXT NOT NULL,
        ts INTEGER NOT NULL,                     -- Unix milliseconds
        status TEXT NOT NULL CHECK (status IN ('pending','booked')),
        amount_minor INTEGER NOT NULL,           -- in the account's currency; signed; no floats anywhere
        currency TEXT NOT NULL,
        description TEXT NOT NULL,
        counterparty TEXT,
        category TEXT NOT NULL,
        category_source TEXT NOT NULL CHECK (category_source IN ('auto','user')),
        mcc INTEGER,
        cashback_minor INTEGER NOT NULL DEFAULT 0,
        commission_minor INTEGER NOT NULL DEFAULT 0,
        comment TEXT,
        receipt_id TEXT,
        balance_after_minor INTEGER,             -- the statement item's own balance field
        UNIQUE (account_id, provider_txn_id)
      );
      CREATE INDEX idx_transactions_account_ts ON transactions(account_id, ts DESC);

      -- Statement reads for a bank that allows one per minute. Rows survive a restart.
      CREATE TABLE sync_jobs (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('history','topup')),
        window_from TEXT NOT NULL,               -- inclusive calendar dates
        window_to TEXT NOT NULL,
        priority REAL NOT NULL,                  -- lower runs first
        status TEXT NOT NULL CHECK (status IN ('pending','done','failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_sync_jobs_pending ON sync_jobs(connection_id, status, priority, created_at);

      -- Last rates monobank published, so Home still converts when the rates call fails.
      CREATE TABLE rates (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        payload TEXT NOT NULL,
        fetched_at TEXT NOT NULL
      );
    `,
  },
  {
    // Several banks at once. The one-connection-per-session rule becomes one-per-bank, and a connection may be an imported
    // statement file (no token, nothing to sync). Every existing row, id and sealed token is carried over unchanged: a
    // sealed token is bound to its connection id, which does not change.
    id: '002_many_connections',
    rebuild: true,
    sql: `
      CREATE TABLE connections_new (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK (provider IN ('monobank','demo','privatbank','privat24')),
        kind TEXT NOT NULL DEFAULT 'api' CHECK (kind IN ('api','file')),
        status TEXT NOT NULL CHECK (status IN ('active','needs_reauth','error')),
        tokens_enc TEXT,                         -- sealed JSON, never sent to the browser; null for a file
        last_refreshed_at TEXT,
        history_months INTEGER NOT NULL DEFAULT 2,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (session_id, provider)
      );
      INSERT INTO connections_new
        (id, session_id, provider, kind, status, tokens_enc, last_refreshed_at, history_months, created_at, updated_at)
        SELECT id, session_id, provider, 'api', status, tokens_enc, last_refreshed_at, history_months, created_at, updated_at
        FROM connections;
      DROP TABLE connections;
      ALTER TABLE connections_new RENAME TO connections;

      -- An imported statement may carry no balance; the account is then left out of the totals instead of counted as zero.
      ALTER TABLE accounts ADD COLUMN balance_known INTEGER NOT NULL DEFAULT 1;
    `,
  },
  {
    // Wise joins the banks a connection may belong to. SQLite cannot widen a CHECK in place, so `connections` is rebuilt the way
    // 002 did it: every row, id and sealed token carried over, row counts and foreign keys verified inside the transaction.
    id: '003_wise',
    rebuild: true,
    sql: `
      CREATE TABLE connections_new (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK (provider IN ('monobank','demo','privatbank','privat24','wise')),
        kind TEXT NOT NULL DEFAULT 'api' CHECK (kind IN ('api','file')),
        status TEXT NOT NULL CHECK (status IN ('active','needs_reauth','error')),
        tokens_enc TEXT,
        last_refreshed_at TEXT,
        history_months INTEGER NOT NULL DEFAULT 2,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (session_id, provider)
      );
      INSERT INTO connections_new
        (id, session_id, provider, kind, status, tokens_enc, last_refreshed_at, history_months, created_at, updated_at)
        SELECT id, session_id, provider, kind, status, tokens_enc, last_refreshed_at, history_months, created_at, updated_at
        FROM connections;
      DROP TABLE connections;
      ALTER TABLE connections_new RENAME TO connections;
    `,
  },
];

const tableNames = (db: Db): string[] =>
  db
    .all<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )
    .map((r) => r.name);

const rowCounts = (db: Db): Map<string, number> =>
  new Map(
    tableNames(db).map((name) => [
      name,
      db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM "${name}"`)?.n ?? 0,
    ]),
  );

function record(db: Db, id: string): void {
  db.run(
    'INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)',
    id,
    new Date().toISOString(),
  );
}

function applyRebuild(db: Db, migration: Migration): void {
  // `PRAGMA foreign_keys` does nothing inside a transaction, so it goes around it.
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.transaction(() => {
      const before = rowCounts(db);
      db.exec(migration.sql);
      record(db, migration.id);
      const after = rowCounts(db);
      for (const [name, count] of before) {
        if ((after.get(name) ?? 0) < count) {
          throw new Error(
            `Migration ${migration.id} would lose rows from ${name}; nothing changed.`,
          );
        }
      }
      if (db.all('PRAGMA foreign_key_check').length > 0) {
        throw new Error(`Migration ${migration.id} would break a foreign key; nothing changed.`);
      }
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

export function migrate(db: Db, available: readonly Migration[] = migrations): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set(
    db.all<{ id: string }>('SELECT id FROM schema_migrations').map((r) => r.id),
  );
  const ran: string[] = [];
  for (const migration of available) {
    if (applied.has(migration.id)) continue;
    if (migration.rebuild) {
      applyRebuild(db, migration);
    } else {
      db.transaction(() => {
        db.exec(migration.sql);
        record(db, migration.id);
      });
    }
    ran.push(migration.id);
  }
  return ran;
}
