import type { Db } from './database';

export interface Migration {
  id: string;
  sql: string;
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
];

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
    db.transaction(() => {
      db.exec(migration.sql);
      db.run(
        'INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)',
        migration.id,
        new Date().toISOString(),
      );
    });
    ran.push(migration.id);
  }
  return ran;
}
