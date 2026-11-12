import { DatabaseSync } from 'node:sqlite';
import { fixedClock } from '@api/clock';
import { Calendar } from '@api/domain/calendar';
import { Store, type SqlDb, type SqlValue } from '../src/data/db';
import type { TokenVault } from '../src/platform/keychain';

/** Node's own SQLite behind the interface the phone's expo-sqlite sits behind: the store's SQL runs for real. */
export function memoryDb(): SqlDb {
  const db = new DatabaseSync(':memory:');
  return {
    exec: (sql) => Promise.resolve(db.exec(sql)),
    run: (sql, params: readonly SqlValue[] = []) =>
      Promise.resolve({ changes: Number(db.prepare(sql).run(...params).changes) }),
    all: <T>(sql: string, params: readonly SqlValue[] = []) =>
      Promise.resolve(db.prepare(sql).all(...params) as T[]),
    transaction: async (task) => {
      db.exec('BEGIN');
      try {
        await task();
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
}

export const openStore = (): Promise<Store> => Store.open(memoryDb());

export function memoryVault(): TokenVault & { value: string | null } {
  const vault = {
    value: null as string | null,
    read: () => Promise.resolve(vault.value),
    save: (token: string) => {
      vault.value = token;
      return Promise.resolve();
    },
    forget: () => {
      vault.value = null;
      return Promise.resolve();
    },
  };
  return vault;
}

export const kyiv = (): Calendar => new Calendar('Europe/Kyiv');
export const clockAt = (iso = '2026-11-11T10:00:00Z') => fixedClock(iso);
