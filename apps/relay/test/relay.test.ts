import { describe, expect, it } from 'vitest';
import { MemoryRelayStore, Relay, type RelayStore } from '../src/relay';
import { DatabaseSync } from 'node:sqlite';
import { D1RelayStore, type D1Like, type D1Statement } from '../src/d1-store';
import { SqliteRelayStore } from '../src/sqlite-store';

/** D1's calls on Node's SQLite: the D1 store's SQL runs for real, though not on Cloudflare. */
function fakeD1(): D1Like {
  const db = new DatabaseSync(':memory:');
  const statement = (sql: string, values: (string | number | null)[] = []): D1Statement => ({
    bind: (...next) => statement(sql, next),
    first: <T>() => Promise.resolve((db.prepare(sql).get(...values) as T | undefined) ?? null),
    all: <T>() => Promise.resolve({ results: db.prepare(sql).all(...values) as T[] }),
    run: () => Promise.resolve(db.prepare(sql).run(...values)),
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      for (const each of statements) await each.run();
    },
  };
}

const FAMILY = 'a'.repeat(32);
const OTHER_FAMILY = 'b'.repeat(32);
const ANNA = '1'.repeat(16);
const BORYS = '2'.repeat(16);
const KEY = 'k'.repeat(43);
const WRONG_KEY = 'w'.repeat(43);

function setup(store: RelayStore = new MemoryRelayStore(), limits = {}) {
  const clock = { now: Date.parse('2026-11-13T10:00:00Z') };
  const relay = new Relay({ store, now: () => clock.now, limits });
  const call = (
    method: string,
    path: string,
    options: { key?: string | null; body?: Uint8Array<ArrayBuffer>; client?: string } = {},
  ): Promise<Response> => {
    const headers = new Headers();
    if (options.key !== null) headers.set('authorization', `Bearer ${options.key ?? KEY}`);
    return relay.handle(
      new Request(`https://relay.test${path}`, { method, headers, body: options.body }),
      options.client ?? 'phone',
    );
  };
  const put = (family: string, member: string, bytes: number[], key = KEY) =>
    call('PUT', `/v1/families/${family}/members/${member}`, { key, body: Uint8Array.from(bytes) });
  const list = async (family: string, key = KEY) => {
    const response = await call('GET', `/v1/families/${family}`, { key });
    const body = (await response.json()) as {
      members?: { id: string; updatedAt: number; blob: string }[];
    };
    return { status: response.status, members: body.members ?? [] };
  };
  return { relay, clock, call, put, list };
}

const bytesOf = (base64: string): number[] => [...Buffer.from(base64, 'base64')];

describe.each([
  ['in memory', () => new MemoryRelayStore()],
  ['on SQLite', () => new SqliteRelayStore(':memory:')],
  ['on D1', () => new D1RelayStore(fakeD1())],
])('the family relay, %s', (_name, makeStore) => {
  it('keeps what a phone leaves and hands it back unchanged to whoever holds the key', async () => {
    const { put, list } = setup(makeStore());
    expect((await put(FAMILY, ANNA, [1, 2, 3])).status).toBe(204);
    expect((await put(FAMILY, BORYS, [9, 8])).status).toBe(204);
    const { status, members } = await list(FAMILY);
    expect(status).toBe(200);
    expect(members.map((m) => [m.id, bytesOf(m.blob)])).toEqual([
      [ANNA, [1, 2, 3]],
      [BORYS, [9, 8]],
    ]);
  });

  it('a newer summary replaces the older one of the same person', async () => {
    const { put, list, clock } = setup(makeStore());
    await put(FAMILY, ANNA, [1]);
    clock.now += 5_000;
    await put(FAMILY, ANNA, [2]);
    const { members } = await list(FAMILY);
    expect(members).toHaveLength(1);
    expect(bytesOf(members[0]?.blob ?? '')).toEqual([2]);
    expect(members[0]?.updatedAt).toBe(clock.now);
  });

  it('the first summary fixes the family key: another key can neither read nor write nor remove', async () => {
    const { put, list, call } = setup(makeStore());
    await put(FAMILY, ANNA, [1]);
    expect((await put(FAMILY, BORYS, [7], WRONG_KEY)).status).toBe(403);
    expect((await list(FAMILY, WRONG_KEY)).status).toBe(404);
    const removed = await call('DELETE', `/v1/families/${FAMILY}/members/${ANNA}`, {
      key: WRONG_KEY,
    });
    expect(removed.status).toBe(404);
    expect((await list(FAMILY)).members).toHaveLength(1);
  });

  it('a family that does not exist and one with the wrong key look the same', async () => {
    const { put, list } = setup(makeStore());
    await put(FAMILY, ANNA, [1]);
    expect((await list(OTHER_FAMILY)).status).toBe((await list(FAMILY, WRONG_KEY)).status);
  });

  it('families do not see each other', async () => {
    const { put, list } = setup(makeStore());
    await put(FAMILY, ANNA, [1]);
    await put(OTHER_FAMILY, ANNA, [2], WRONG_KEY);
    expect((await list(FAMILY)).members.map((m) => bytesOf(m.blob))).toEqual([[1]]);
    expect((await list(OTHER_FAMILY, WRONG_KEY)).members.map((m) => bytesOf(m.blob))).toEqual([
      [2],
    ]);
  });

  it('leaving removes the summary, and the family goes with its last member', async () => {
    const { put, list, call } = setup(makeStore());
    await put(FAMILY, ANNA, [1]);
    await put(FAMILY, BORYS, [2]);
    expect((await call('DELETE', `/v1/families/${FAMILY}/members/${ANNA}`)).status).toBe(204);
    expect((await list(FAMILY)).members.map((m) => m.id)).toEqual([BORYS]);
    await call('DELETE', `/v1/families/${FAMILY}/members/${BORYS}`);
    expect((await list(FAMILY)).status).toBe(404);
    // The id is free again: whoever comes next fixes a new key.
    expect((await put(FAMILY, ANNA, [5], WRONG_KEY)).status).toBe(204);
  });

  it('a summary nobody renewed for 90 days is removed', async () => {
    const { put, list, clock } = setup(makeStore());
    await put(FAMILY, ANNA, [1]);
    clock.now += 60 * 24 * 60 * 60_000;
    await put(FAMILY, BORYS, [2]);
    clock.now += 31 * 24 * 60 * 60_000;
    expect((await list(FAMILY)).members.map((m) => m.id)).toEqual([BORYS]);
  });

  it('refuses a ninth person, but lets the eight renew', async () => {
    const { put } = setup(makeStore());
    for (let i = 0; i < 8; i += 1) {
      expect((await put(FAMILY, String(i).repeat(16), [i])).status).toBe(204);
    }
    expect((await put(FAMILY, 'f'.repeat(16), [1])).status).toBe(409);
    expect((await put(FAMILY, '0'.repeat(16), [1])).status).toBe(204);
  });
});

describe('the family relay, its limits and its manners', () => {
  it('refuses a summary that is empty or too large', async () => {
    const { call } = setup();
    const path = `/v1/families/${FAMILY}/members/${ANNA}`;
    expect((await call('PUT', path, { body: new Uint8Array(0) })).status).toBe(400);
    expect((await call('PUT', path, { body: new Uint8Array(32 * 1024 + 1) })).status).toBe(413);
    expect((await call('PUT', path, { body: new Uint8Array(32 * 1024) })).status).toBe(204);
  });

  it('refuses ids and keys that are not the shape the phones make', async () => {
    const { call } = setup();
    expect((await call('GET', '/v1/families/short')).status).toBe(404);
    expect((await call('PUT', `/v1/families/${FAMILY}/members/nope`)).status).toBe(404);
    expect((await call('GET', `/v1/families/${FAMILY}`, { key: null })).status).toBe(401);
    expect((await call('GET', `/v1/families/${FAMILY}`, { key: 'short' })).status).toBe(401);
    expect((await call('POST', `/v1/families/${FAMILY}/members/${ANNA}`)).status).toBe(405);
    expect((await call('GET', '/somewhere')).status).toBe(404);
  });

  it('stops creating families when it is full, and still serves the ones it has', async () => {
    const { put, list } = setup(new MemoryRelayStore(), { maxFamilies: 1 });
    await put(FAMILY, ANNA, [1]);
    expect((await put(OTHER_FAMILY, ANNA, [1])).status).toBe(507);
    expect((await put(FAMILY, BORYS, [2])).status).toBe(204);
    expect((await list(FAMILY)).members).toHaveLength(2);
  });

  it('slows one client down without touching another, and health is always answered', async () => {
    const { call, clock } = setup(new MemoryRelayStore(), { requestsPerMinute: 3 });
    const path = `/v1/families/${FAMILY}`;
    for (let i = 0; i < 3; i += 1) expect((await call('GET', path)).status).toBe(404);
    expect((await call('GET', path)).status).toBe(429);
    expect((await call('GET', path, { client: 'another phone' })).status).toBe(404);
    expect((await call('GET', '/health', { key: null })).status).toBe(200);
    clock.now += 60_000;
    expect((await call('GET', path)).status).toBe(404);
  });

  it('keeps only the hash of the key and the bytes it was given', async () => {
    const store = new MemoryRelayStore();
    const { put } = setup(store);
    await put(FAMILY, ANNA, [1, 2, 3]);
    const kept = JSON.stringify([store.accessHash(FAMILY), store.members(FAMILY)]);
    expect(kept).not.toContain(KEY);
    expect(store.accessHash(FAMILY)).toMatch(/^[0-9a-f]{64}$/);
  });
});
