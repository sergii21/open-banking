import { describe, expect, it } from 'vitest';
import { Db } from '../src/db/database';
import { migrate, migrations } from '../src/db/migrations';

describe('migrations', () => {
  it('applies every migration once and is idempotent', () => {
    const db = new Db(':memory:');
    const first = migrate(db);
    expect(first).toEqual(migrations.map((m) => m.id));
    expect(migrate(db)).toEqual([]);
    expect(db.all<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id')).toHaveLength(
      migrations.length,
    );
    db.close();
  });

  it('rolls a failing migration back completely', () => {
    const db = new Db(':memory:');
    expect(() =>
      migrate(db, [
        { id: '900_broken', sql: 'CREATE TABLE ok (id TEXT); CREATE TABLE ok (id TEXT);' },
      ]),
    ).toThrow();
    expect(db.get('SELECT name FROM sqlite_master WHERE name = ?', 'ok')).toBeUndefined();
    db.close();
  });
});

/** A database exactly as v2 left it (only the first migration), with a bank connected and some history. */
function v2Database(): Db {
  const db = new Db(':memory:');
  migrate(db, migrations.slice(0, 1));
  db.run(
    `INSERT INTO sessions (id, created_at, last_seen_at) VALUES ('s1', '2026-10-30T10:00:00Z', '2026-11-03T10:00:00Z')`,
  );
  db.run(
    `INSERT INTO connections (id, session_id, provider, status, tokens_enc, last_refreshed_at, history_months, created_at, updated_at)
     VALUES ('con_a', 's1', 'monobank', 'active', 'v1.k1.sealed.sealed.sealed', '2026-11-03T09:00:00Z', 3, '2026-10-30T10:00:00Z', '2026-11-03T09:00:00Z')`,
  );
  for (const [id, name] of [
    ['acc_a', 'Black'],
    ['acc_b', 'Jar'],
  ] as const) {
    db.run(
      `INSERT INTO accounts (id, connection_id, provider_account_id, kind, card_type, name, currency, last4, balance_minor, balance_at, covered_from, covered_to)
       VALUES (?, 'con_a', ?, 'card', 'black', ?, 'UAH', '1234', 1500000, '2026-11-03T09:00:00Z', '2026-09-03', '2026-11-03')`,
      id,
      `p_${id}`,
      name,
    );
  }
  for (let i = 0; i < 5; i += 1) {
    db.run(
      `INSERT INTO transactions (id, account_id, provider_txn_id, ts, status, amount_minor, currency, description, category, category_source)
       VALUES (?, 'acc_a', ?, ?, 'booked', ?, 'UAH', 'Сільпо', 'groceries', ?)`,
      `txn_${i}`,
      `t_${i}`,
      1_700_000_000_000 + i,
      -12_300 - i,
      i === 0 ? 'user' : 'auto',
    );
  }
  db.run(
    `INSERT INTO sync_jobs (id, connection_id, account_id, kind, window_from, window_to, priority, status, created_at, updated_at)
     VALUES ('job_1', 'con_a', 'acc_a', 'history', '2026-10-01', '2026-10-31', 10, 'pending', '2026-11-03T09:00:00Z', '2026-11-03T09:00:00Z')`,
  );
  return db;
}

describe('002_many_connections', () => {
  it('carries a v2 database over with every row, id and sealed token as it was', () => {
    const db = v2Database();
    const before = {
      connection: db.get('SELECT * FROM connections'),
      accounts: db.all('SELECT * FROM accounts ORDER BY id'),
      transactions: db.all('SELECT * FROM transactions ORDER BY id'),
      jobs: db.all('SELECT * FROM sync_jobs'),
    };

    expect(migrate(db)).toEqual(['002_many_connections']);

    // Fresh SQL text: a statement prepared before the migration keeps the column list it was prepared with.
    expect(db.get('SELECT * FROM connections WHERE 1 = 1')).toEqual({
      ...(before.connection as object),
      kind: 'api',
    });
    expect(db.all('SELECT * FROM transactions WHERE 1 = 1 ORDER BY id')).toEqual(
      before.transactions,
    );
    expect(db.all('SELECT * FROM sync_jobs WHERE 1 = 1')).toEqual(before.jobs);
    expect(db.all('SELECT * FROM accounts WHERE 1 = 1 ORDER BY id')).toEqual(
      (before.accounts as object[]).map((row) => ({ ...row, balance_known: 1 })),
    );
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
    expect(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys).toBe(1);
    db.close();
  });

  it('then allows one connection per bank in a session, a file kind, and still cascades', () => {
    const db = v2Database();
    migrate(db);
    const add = (id: string, provider: string, kind: string) =>
      db.run(
        `INSERT INTO connections (id, session_id, provider, kind, status, created_at, updated_at)
         VALUES (?, 's1', ?, ?, 'active', '2026-11-03T10:00:00Z', '2026-11-03T10:00:00Z')`,
        id,
        provider,
        kind,
      );
    add('con_b', 'privatbank', 'api');
    add('con_c', 'privat24', 'file');
    expect(() => add('con_d', 'monobank', 'api')).toThrow(); // the same bank twice
    expect(() => add('con_e', 'unknown', 'api')).toThrow();
    expect(() => add('con_f', 'privatbank', 'cloud')).toThrow();
    expect(
      db.all('SELECT id FROM connections ORDER BY id').map((r) => (r as { id: string }).id),
    ).toEqual(['con_a', 'con_b', 'con_c']);

    db.run(`DELETE FROM sessions WHERE id = 's1'`);
    for (const table of ['connections', 'accounts', 'transactions', 'sync_jobs']) {
      expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n).toBe(0);
    }
    db.close();
  });

  it('refuses to lose a row: a rebuild that drops data rolls back and changes nothing', () => {
    const db = v2Database();
    migrate(db, migrations.slice(0, 1));
    expect(() =>
      migrate(db, [
        ...migrations.slice(0, 1),
        { id: '900_lossy', rebuild: true, sql: 'DELETE FROM transactions;' },
      ]),
    ).toThrow(/lose rows from transactions/);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM transactions')?.n).toBe(5);
    expect(db.get('SELECT id FROM schema_migrations WHERE id = ?', '900_lossy')).toBeUndefined();
    expect(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys).toBe(1);
    db.close();
  });

  it('refuses a rebuild that leaves a row pointing nowhere', () => {
    const db = v2Database();
    expect(() =>
      migrate(db, [
        ...migrations.slice(0, 1),
        { id: '901_orphan', rebuild: true, sql: `UPDATE accounts SET connection_id = 'missing';` },
      ]),
    ).toThrow(/foreign key/);
    expect(db.get<{ c: string }>(`SELECT connection_id AS c FROM accounts LIMIT 1`)?.c).toBe(
      'con_a',
    );
    db.close();
  });
});

describe('Db.transaction', () => {
  it('commits, rolls back on error and supports nesting through savepoints', () => {
    const db = new Db(':memory:');
    db.exec('CREATE TABLE t (n INTEGER)');

    db.transaction(() => {
      db.run('INSERT INTO t VALUES (?)', 1);
      expect(() =>
        db.transaction(() => {
          db.run('INSERT INTO t VALUES (?)', 2);
          throw new Error('inner failure');
        }),
      ).toThrow('inner failure');
      db.run('INSERT INTO t VALUES (?)', 3);
    });

    expect(db.all<{ n: number }>('SELECT n FROM t ORDER BY n').map((r) => r.n)).toEqual([1, 3]);

    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO t VALUES (?)', 4);
        throw new Error('outer failure');
      }),
    ).toThrow('outer failure');
    expect(db.all('SELECT n FROM t')).toHaveLength(2);
    db.close();
  });
});
