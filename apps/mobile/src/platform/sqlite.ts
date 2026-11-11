import { openDatabaseAsync } from 'expo-sqlite';
import type { SqlDb, SqlValue } from '../data/db';

/** The phone's database file, in the app's own folder. */
export async function openPhoneDb(): Promise<SqlDb> {
  const db = await openDatabaseAsync('ledger-lens.db');
  return {
    exec: (sql) => db.execAsync(sql),
    run: async (sql, params: readonly SqlValue[] = []) => {
      const result = await db.runAsync(sql, [...params]);
      return { changes: result.changes };
    },
    all: <T>(sql: string, params: readonly SqlValue[] = []) => db.getAllAsync<T>(sql, [...params]),
    transaction: (task) => db.withTransactionAsync(task),
  };
}
