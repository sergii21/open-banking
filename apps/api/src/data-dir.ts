import { chmodSync, existsSync, mkdirSync } from 'node:fs';

/**
 * The data folder holds the transaction history (as plain data) and the key that seals the token, so it belongs to the owner
 * alone: created 0700, and tightened if an older run left it open. Not something to do to a folder that is not ours: callers
 * pass only the app's own data directory.
 */
export function secureDataDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Not ours to change (a shared mount, another OS): the files inside are still restricted one by one.
  }
}

/** The database and its write-ahead files, readable by the owner only. */
export function secureDatabaseFiles(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${path}${suffix}`;
    if (!existsSync(file)) continue;
    try {
      chmodSync(file, 0o600);
    } catch {
      // As above.
    }
  }
}
