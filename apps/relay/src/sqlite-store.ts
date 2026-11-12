import { DatabaseSync } from 'node:sqlite';
import type { RelayStore, StoredMember } from './relay';

/** The relay's whole memory: a family's id with the hash of its access key, and the sealed summaries. No names, no figures. */
export class SqliteRelayStore implements RelayStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS families (
        id TEXT PRIMARY KEY, access_hash TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS members (
        family_id TEXT NOT NULL REFERENCES families (id) ON DELETE CASCADE,
        id TEXT NOT NULL, updated_at INTEGER NOT NULL, blob BLOB NOT NULL,
        PRIMARY KEY (family_id, id)
      );
    `);
  }

  accessHash(familyId: string): string | null {
    const row = this.db.prepare('SELECT access_hash FROM families WHERE id = ?').get(familyId) as
      { access_hash: string } | undefined;
    return row?.access_hash ?? null;
  }

  createFamily(familyId: string, accessHash: string, now: number): void {
    this.db
      .prepare('INSERT INTO families (id, access_hash, created_at) VALUES (?, ?, ?)')
      .run(familyId, accessHash, now);
  }

  familyCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM families').get() as { n: number };
    return row.n;
  }

  members(familyId: string): StoredMember[] {
    const rows = this.db
      .prepare('SELECT id, updated_at, blob FROM members WHERE family_id = ? ORDER BY id')
      .all(familyId) as { id: string; updated_at: number; blob: Uint8Array }[];
    return rows.map((row) => ({
      id: row.id,
      updatedAt: row.updated_at,
      blob: new Uint8Array(row.blob),
    }));
  }

  putMember(familyId: string, memberId: string, blob: Uint8Array, now: number): void {
    this.db
      .prepare(
        `INSERT INTO members (family_id, id, updated_at, blob) VALUES (?, ?, ?, ?)
         ON CONFLICT (family_id, id) DO UPDATE SET updated_at = excluded.updated_at, blob = excluded.blob`,
      )
      .run(familyId, memberId, now, blob);
  }

  removeMember(familyId: string, memberId: string): void {
    this.db.prepare('DELETE FROM members WHERE family_id = ? AND id = ?').run(familyId, memberId);
  }

  removeFamily(familyId: string): void {
    this.db.prepare('DELETE FROM families WHERE id = ?').run(familyId);
  }

  purge(before: number): void {
    this.db.prepare('DELETE FROM members WHERE updated_at < ?').run(before);
    this.db.exec('DELETE FROM families WHERE id NOT IN (SELECT family_id FROM members)');
  }

  close(): void {
    this.db.close();
  }
}
