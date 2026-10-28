import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

export type SqlParam = SQLInputValue;

/**
 * Thin synchronous wrapper over node:sqlite. Everything that touches SQL goes through here so the
 * driver can be swapped (better-sqlite3 is the documented fallback while node:sqlite is early-stability).
 */
export class Db {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;

  constructor(readonly path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (path !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    }
  }

  private prepare(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  run(sql: string, ...params: SqlParam[]): { changes: number } {
    const result = this.prepare(sql).run(...params);
    return { changes: Number(result.changes) };
  }

  get<T>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SqlParam[]): T[] {
    return this.prepare(sql).all(...params) as T[];
  }

  /** Runs `fn` atomically. Nested calls become savepoints, so repositories can compose freely. */
  transaction<T>(fn: () => T): T {
    const nested = this.depth > 0;
    const savepoint = `sp_${this.depth}`;
    this.db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this.depth += 1;
    try {
      const result = fn();
      this.depth -= 1;
      this.db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      this.depth -= 1;
      this.db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
      throw error;
    }
  }

  ping(): boolean {
    return this.get<{ ok: number }>('SELECT 1 AS ok')?.ok === 1;
  }

  close(): void {
    this.statements.clear();
    this.db.close();
  }
}
