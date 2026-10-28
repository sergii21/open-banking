import type { Db } from './database';

export interface Migration {
  id: string;
  sql: string;
}

/**
 * Append-only. Migrations are TypeScript string modules rather than .sql files so they survive the
 * esbuild bundle and `tsx` without a loader. Never edit an applied migration; add a new one.
 */
export const migrations: Migration[] = [
  {
    id: '001_sessions',
    sql: `
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,            -- SHA-256 of the cookie token, never the token itself
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
    `,
  },
  {
    id: '002_account_information',
    sql: `
      CREATE TABLE connections (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        institution_id TEXT NOT NULL,            -- '<provider>:<slug>'
        institution_name TEXT NOT NULL,
        institution_logo_url TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending','active','expired','revoked','needs_reauth','error')),
        state TEXT UNIQUE,                       -- OAuth state, only while a consent redirect is in flight
        state_expires_at TEXT,
        code_verifier_enc TEXT,                  -- PKCE verifier, sealed, only while pending
        tokens_enc TEXT,                         -- sealed JSON token set, never sent to the browser
        token_expires_at TEXT,
        permissions TEXT NOT NULL DEFAULT '[]',
        consent_expires_at TEXT,
        last_refreshed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX idx_connections_session ON connections(session_id);

      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        provider_account_id TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        currency TEXT NOT NULL,
        masked_identifier TEXT,                  -- the full IBAN / account number is never stored
        balance_minor INTEGER NOT NULL,
        available_minor INTEGER,
        balance_at TEXT NOT NULL,
        last_refreshed_at TEXT NOT NULL,
        UNIQUE (connection_id, provider_account_id)
      );

      CREATE TABLE transactions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        provider_txn_id TEXT NOT NULL,
        booked_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','booked')),
        amount_minor INTEGER NOT NULL,           -- signed integer minor units; no floats anywhere
        currency TEXT NOT NULL,
        description TEXT NOT NULL,
        counterparty TEXT,
        category TEXT NOT NULL,
        category_source TEXT NOT NULL CHECK (category_source IN ('auto','user')),
        UNIQUE (account_id, provider_txn_id)
      );
      CREATE INDEX idx_transactions_account_date ON transactions(account_id, booked_at DESC, id DESC);
    `,
  },
  {
    id: '003_mock_bank',
    sql: `
      -- State of the fake bank. It lives in the same database but is only ever touched by providers/mock.
      CREATE TABLE mock_consents (
        id TEXT PRIMARY KEY,
        institution TEXT NOT NULL,
        persona TEXT NOT NULL,
        client_id TEXT NOT NULL,
        seed TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        fail_next TEXT                           -- demo control: 'unavailable' | 'rate_limit', consumed by one data call
      );
      CREATE TABLE mock_auth_codes (
        code_hash TEXT PRIMARY KEY,
        consent_id TEXT NOT NULL REFERENCES mock_consents(id) ON DELETE CASCADE,
        redirect_uri TEXT NOT NULL,
        code_challenge TEXT,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );
      CREATE TABLE mock_tokens (
        token_hash TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('access','refresh')),
        consent_id TEXT NOT NULL REFERENCES mock_consents(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL,
        used_at TEXT
      );
    `,
  },
  {
    id: '004_payments',
    sql: `
      CREATE TABLE payments (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        institution_id TEXT NOT NULL,
        institution_name TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,           -- the client's key; unique per session
        request_hash TEXT NOT NULL,              -- same key with a different request is refused, not silently replayed
        provider_idempotency_key TEXT NOT NULL,  -- sent to the provider, so retrying an unknown outcome cannot pay twice
        provider_payment_id TEXT,                -- null until the provider has accepted the payment
        amount_minor INTEGER NOT NULL,
        currency TEXT NOT NULL,
        beneficiary_name TEXT NOT NULL,
        beneficiary_identifier TEXT NOT NULL,    -- masked; the full identifier is never stored
        reference TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','authorised','executed','settled','failed','cancelled')),
        settlement_expected INTEGER NOT NULL DEFAULT 1,
        failure_reason TEXT,
        status_history TEXT NOT NULL,
        auth_url_enc TEXT,                       -- sealed: the bank link carries a one-time resource token
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_checked_at TEXT,                    -- last webhook or poll that touched this payment
        UNIQUE (session_id, idempotency_key)
      );
      CREATE UNIQUE INDEX idx_payments_provider_id ON payments(provider, provider_payment_id)
        WHERE provider_payment_id IS NOT NULL;
      CREATE INDEX idx_payments_session ON payments(session_id, created_at DESC);

      CREATE TABLE webhook_events (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        event_id TEXT NOT NULL,                  -- the provider's id: the same event delivered twice shares it
        event_type TEXT NOT NULL,
        provider_payment_id TEXT,
        payload TEXT NOT NULL,
        received_at TEXT NOT NULL,
        outcome TEXT NOT NULL,
        UNIQUE (provider, event_id)
      );
    `,
  },
  {
    id: '005_mock_payments',
    sql: `
      -- Which Ledger Lens customer a mock consent belongs to, so payments they make show up in their own mock accounts only.
      ALTER TABLE mock_consents ADD COLUMN customer_ref TEXT;

      CREATE TABLE mock_payments (
        id TEXT PRIMARY KEY,
        institution TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        request_hash TEXT NOT NULL,
        amount_minor INTEGER NOT NULL,
        currency TEXT NOT NULL,
        beneficiary_name TEXT NOT NULL,
        beneficiary_identifier TEXT NOT NULL,
        reference TEXT NOT NULL,
        return_uri TEXT NOT NULL,
        customer_ref TEXT NOT NULL,
        settlement_expected INTEGER NOT NULL,
        resource_token_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('authorization_required','authorizing','authorized','executed','settled','failed')),
        failure_stage TEXT,
        failure_reason TEXT,
        persona TEXT,
        outcome TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        executed_at TEXT,
        settled_at TEXT,
        failed_at TEXT,
        next_status TEXT,                        -- the scheduled transition, applied by the bank's ticker
        next_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE mock_outbox (
        id TEXT PRIMARY KEY,
        payment_id TEXT NOT NULL REFERENCES mock_payments(id) ON DELETE CASCADE,
        event_id TEXT NOT NULL,
        type TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        delivered_at TEXT,
        last_status INTEGER
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
