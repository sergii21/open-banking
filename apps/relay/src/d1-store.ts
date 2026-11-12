import type { RelayStore, StoredMember } from './relay';

/** As much of Cloudflare's D1 as the relay uses, so no Cloudflare package is needed to build or test it. */
export interface D1Statement {
  bind(...values: (string | number | null)[]): D1Statement;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}
export interface D1Like {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS families (
     id TEXT PRIMARY KEY, access_hash TEXT NOT NULL, created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS members (
     family_id TEXT NOT NULL, id TEXT NOT NULL, updated_at INTEGER NOT NULL, blob TEXT NOT NULL,
     PRIMARY KEY (family_id, id)
   )`,
];

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
const fromBase64 = (text: string): Uint8Array =>
  Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

/**
 * The relay's memory on Cloudflare D1: the same two tables as the SQLite store. The sealed bytes are kept as base64
 * text, which D1 hands back exactly as it was given.
 */
export class D1RelayStore implements RelayStore {
  private ready: Promise<unknown> | null = null;

  constructor(private readonly db: D1Like) {}

  /** The tables are made on the first call of a fresh instance: there is no separate migration step to forget. */
  private async prepared(): Promise<D1Like> {
    this.ready ??= this.db.batch(SCHEMA.map((sql) => this.db.prepare(sql)));
    await this.ready;
    return this.db;
  }

  async accessHash(familyId: string): Promise<string | null> {
    const db = await this.prepared();
    const row = await db
      .prepare('SELECT access_hash FROM families WHERE id = ?')
      .bind(familyId)
      .first<{ access_hash: string }>();
    return row?.access_hash ?? null;
  }

  async createFamily(familyId: string, accessHash: string, now: number): Promise<void> {
    const db = await this.prepared();
    await db
      .prepare('INSERT INTO families (id, access_hash, created_at) VALUES (?, ?, ?)')
      .bind(familyId, accessHash, now)
      .run();
  }

  async familyCount(): Promise<number> {
    const db = await this.prepared();
    const row = await db.prepare('SELECT COUNT(*) AS n FROM families').first<{ n: number }>();
    return row?.n ?? 0;
  }

  async members(familyId: string): Promise<StoredMember[]> {
    const db = await this.prepared();
    const { results } = await db
      .prepare('SELECT id, updated_at, blob FROM members WHERE family_id = ? ORDER BY id')
      .bind(familyId)
      .all<{ id: string; updated_at: number; blob: string }>();
    return results.map((row) => ({
      id: row.id,
      updatedAt: row.updated_at,
      blob: fromBase64(row.blob),
    }));
  }

  async putMember(
    familyId: string,
    memberId: string,
    blob: Uint8Array,
    now: number,
  ): Promise<void> {
    const db = await this.prepared();
    await db
      .prepare(
        `INSERT INTO members (family_id, id, updated_at, blob) VALUES (?, ?, ?, ?)
         ON CONFLICT (family_id, id) DO UPDATE SET updated_at = excluded.updated_at, blob = excluded.blob`,
      )
      .bind(familyId, memberId, now, toBase64(blob))
      .run();
  }

  async removeMember(familyId: string, memberId: string): Promise<void> {
    const db = await this.prepared();
    await db
      .prepare('DELETE FROM members WHERE family_id = ? AND id = ?')
      .bind(familyId, memberId)
      .run();
  }

  async removeFamily(familyId: string): Promise<void> {
    const db = await this.prepared();
    await db.batch([
      db.prepare('DELETE FROM members WHERE family_id = ?').bind(familyId),
      db.prepare('DELETE FROM families WHERE id = ?').bind(familyId),
    ]);
  }

  async purge(before: number): Promise<void> {
    const db = await this.prepared();
    await db.batch([
      db.prepare('DELETE FROM members WHERE updated_at < ?').bind(before),
      db.prepare('DELETE FROM families WHERE id NOT IN (SELECT family_id FROM members)'),
    ]);
  }
}
