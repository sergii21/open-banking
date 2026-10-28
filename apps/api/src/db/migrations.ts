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
