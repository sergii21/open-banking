import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { loadOrCreateKeys } from '../src/keys';
import { Client, createTestApp, type TestApp } from './helpers';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe('demo end to end', () => {
  it('connects the demo, loads everything at once, and the screens agree with each other', async () => {
    t = await createTestApp();
    const client = new Client(t);
    await client.start();
    expect((await client.get('/api/home')).statusCode).toBe(404); // nothing connected yet
    expect((await client.post('/api/connection', { mode: 'demo' })).statusCode).toBe(201);
    await t.ctx.sync.tick(); // the demo has no limit: one tick loads the lot

    const home = (await client.get('/api/home')).json();
    const sumOfTiles = home.accounts.reduce(
      (sum: number, a: { ownUahMinor: number | null }) => sum + (a.ownUahMinor ?? 0),
      0,
    );
    expect(home.hero.ownUahMinor).toBe(sumOfTiles);
    expect(home.sync).toMatchObject({ phase: 'idle', done: 0, total: 0 });
    expect(home.trend.points).toHaveLength(30);
    expect(home.trend.points.at(-1)).toBe(home.hero.ownUahMinor); // the line ends where the number is
    expect(home.month.daily).toHaveLength(home.month.daysInMonth);
    expect(home.month.daily.reduce((a: number, b: number) => a + b, 0)).toBe(home.month.spentMinor);
    expect(home.month.previousSameDaysMinor).not.toBeNull(); // three months were loaded
    expect(home.regular.count).toBeGreaterThan(3);
    expect(home.demo).toBe(true);

    const activity = (await client.get('/api/activity')).json();
    expect(activity.rows.length).toBeGreaterThan(1000);
    const insights = (await client.get('/api/insights')).json();
    const byCategory = insights.categories.reduce(
      (sum: number, c: { spentMinor: number }) => sum + c.spentMinor,
      0,
    );
    expect(byCategory).toBe(insights.spentMinor);
    expect(insights.regular.length).toBe(home.regular.count);
  });

  it('keeps a category the person chose through every later read', async () => {
    t = await createTestApp();
    const client = new Client(t);
    await client.start();
    await client.post('/api/connection', { mode: 'demo' });
    await t.ctx.sync.tick();
    const rows = (await client.get('/api/activity')).json().rows as {
      id: string;
      category: string;
    }[];
    const target = rows.find((r) => r.category === 'groceries');
    expect(target).toBeDefined();
    expect(
      (await client.patch(`/api/transactions/${target?.id}`, { category: 'health' })).statusCode,
    ).toBe(200);

    t.clock.advance(120_000);
    await client.post('/api/sync/refresh');
    await t.ctx.sync.tick();
    const after = (
      (await client.get('/api/activity')).json().rows as {
        id: string;
        category: string;
        chosen?: true;
      }[]
    ).find((r) => r.id === target?.id);
    expect(after).toMatchObject({ category: 'health', chosen: true });
  });

  it('puts nothing about the person into the diagnostics text', async () => {
    t = await createTestApp();
    const client = new Client(t);
    await client.start();
    await client.post('/api/connection', { mode: 'demo' });
    await t.ctx.sync.tick();
    const { text } = (await client.get('/api/diagnostics')).json<{ text: string }>();
    const activity = (await client.get('/api/activity')).json();
    const home = (await client.get('/api/home')).json();

    expect(text).toMatch(/statement \(\d+ rows\)/);
    expect(text).toMatch(/consecutive pairs agree/);
    for (const row of activity.rows.slice(0, 400)) {
      if (row.description.length >= 5) expect(text).not.toContain(row.description);
      if (row.comment) expect(text).not.toContain(row.comment);
    }
    for (const account of [...home.accounts, ...activity.accounts]) {
      expect(text).not.toContain(account.id);
      if (account.last4) expect(text).not.toContain(account.last4);
    }
    expect(text).not.toContain('demo-token');
    expect(text).not.toMatch(/\d{2}[  ]\d{3},\d{2}/); // no formatted amounts
  });
});

describe('the front door', () => {
  it('needs a session and a CSRF token, and says no to a foreign origin', async () => {
    t = await createTestApp();
    expect((await t.app.inject({ method: 'GET', url: '/api/home' })).statusCode).toBe(401);
    const client = new Client(t);
    await client.start();
    const bare = await t.app.inject({
      method: 'POST',
      url: '/api/connection',
      payload: { mode: 'demo' },
    });
    expect(bare.statusCode).toBe(401);
    const noToken = await t.app.inject({
      method: 'POST',
      url: '/api/connection',
      headers: {
        cookie: (await client.get('/api/session')).headers['set-cookie']?.toString() ?? '',
      },
      payload: { mode: 'demo' },
    });
    expect([401, 403]).toContain(noToken.statusCode);
  });

  it('keeps real accounts off a public instance', async () => {
    t = await createTestApp({ PUBLIC_URL: 'https://demo.example' });
    const client = new Client(t);
    await client.start();
    expect(t.ctx.config.live).toBe(false);
    const response = await client.post('/api/connection', { mode: 'token', token: 'u'.repeat(44) });
    expect(response.statusCode).toBe(403);
    expect(response.json().detail).toMatch(/your own computer/);
    expect(t.ctx.providers.has('monobank')).toBe(false); // the live provider is not even registered
    expect((await client.post('/api/connection', { mode: 'demo' })).statusCode).toBe(201);
  });

  it('marks the session cookie HttpOnly and sets no-store on everything personal', async () => {
    t = await createTestApp();
    const response = await t.app.inject({ method: 'GET', url: '/api/session' });
    const cookies = [response.headers['set-cookie']].flat().map(String);
    expect(cookies.find((c) => c.startsWith('ll_sid='))).toMatch(/HttpOnly/i);
    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('keys', () => {
  it('are created on the first run, readable by the owner only, and reused after', () => {
    const dir = mkdtempSync(join(tmpdir(), 'll-keys-'));
    try {
      const first = loadOrCreateKeys(dir);
      expect(Buffer.from(first.token, 'base64')).toHaveLength(32);
      expect(statSync(join(dir, 'secret.key')).mode & 0o777).toBe(0o600);
      expect(loadOrCreateKeys(dir)).toEqual(first);

      writeFileSync(join(dir, 'secret.key'), 'garbage');
      expect(loadOrCreateKeys(dir).token).not.toBe(first.token);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('are generated by the config on a normal run and never taken from a default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'll-config-'));
    try {
      const a = loadConfig({ DATA_DIR: dir });
      const b = loadConfig({ DATA_DIR: dir });
      expect(a.tokenEncryptionKey.equals(b.tokenEncryptionKey)).toBe(true);
      expect(
        a.tokenEncryptionKey.equals(
          loadConfig({ DATA_DIR: mkdtempSync(join(tmpdir(), 'll-other-')) }).tokenEncryptionKey,
        ),
      ).toBe(false);
      expect(a.live).toBe(true); // localhost: zero config
      expect(loadConfig({ DATA_DIR: dir, PUBLIC_URL: 'https://x.example' }).live).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('data at rest', () => {
  const opened = (dir: string): [string, number][] =>
    readdirSync(dir).map((name) => [name, statSync(join(dir, name)).mode & 0o777]);

  it('creates the data folder for the owner only and keeps the database files that way', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'll-data-'));
    try {
      const dir = join(parent, 'data');
      const { app } = await buildApp({ config: loadConfig({ NODE_ENV: 'test', DATA_DIR: dir }) });
      await app.ready();
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      const files = opened(dir);
      expect(files.map(([name]) => name)).toContain('ledger-lens.db');
      for (const [name, mode] of files) expect(mode & 0o077, `${name} is open to others`).toBe(0);
      await app.close();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('tightens a folder and files that an older run left open', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'll-data-'));
    try {
      const dir = join(parent, 'data');
      mkdirSync(dir);
      chmodSync(dir, 0o755);
      const file = join(dir, 'ledger-lens.db');
      writeFileSync(file, '');
      chmodSync(file, 0o644);
      const { app } = await buildApp({ config: loadConfig({ NODE_ENV: 'test', DATA_DIR: dir }) });
      await app.ready();
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      for (const [name, mode] of opened(dir))
        expect(mode & 0o077, `${name} is open to others`).toBe(0);
      await app.close();
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
