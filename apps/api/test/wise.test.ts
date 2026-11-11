import { describe, expect, it } from 'vitest';
import { fixedClock } from '../src/clock';
import { DiagnosticsCollector } from '../src/domain/diagnostics';
import { Db } from '../src/db/database';
import { migrate, migrations } from '../src/db/migrations';
import { EventBus } from '../src/modules/events/event-bus';
import { InspectorStore } from '../src/modules/inspector/inspector-store';
import { TokenRejectedError } from '../src/providers/port';
import { STRONG_AUTH_MESSAGE, WiseProvider } from '../src/providers/wise/adapter';
import { FAKE_WISE_PROFILE_ID, type FakeWise } from '../src/providers/wise/demo/fake';
import { ProviderHttp, type Transport } from '../src/providers/transport';
import { Client, FAKE_WISE_TOKEN, NOW, createTestApp, paced, pauseOn, wise } from './helpers';

const CTX = { sessionId: 'ses_test', connectionId: null };
const TOKENS = { accessToken: FAKE_WISE_TOKEN };
const API = 'https://api.wise.test/2026Q4';

function rig(transport?: (fake: FakeWise) => Transport) {
  const clock = fixedClock(NOW);
  const fake = wise(clock);
  const inspector = new InspectorStore(new EventBus());
  const diagnostics = new DiagnosticsCollector();
  const provider = new WiseProvider({
    id: 'wise',
    mode: 'live',
    label: 'Wise',
    http: new ProviderHttp({
      provider: 'wise',
      mode: 'live',
      transport: transport ? transport(fake) : fake.transport,
      inspector,
      clock,
    }),
    apiUrl: API,
    limits: {
      statementIntervalMs: 1000,
      infoIntervalMs: 1000,
      maxWindowDays: 31,
      maxItemsPerCall: Number.MAX_SAFE_INTEGER,
      historyMonths: 1,
      sharedLimit: true,
      balancesOnly: true,
    },
    clock,
    diagnostics,
    pause: pauseOn(clock),
  });
  return { clock, fake, inspector, diagnostics, provider };
}

const answer =
  (body: string, status = 200, headers: Record<string, string> = {}): Transport =>
  () =>
    Promise.resolve(
      new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } }),
    );

describe('Wise adapter (balances only)', () => {
  it('reads profiles then balances, one account per balance, in exact minor units, with no card number', async () => {
    const { provider } = rig();
    const { accounts } = await provider.connect({ token: `  ${FAKE_WISE_TOKEN}\n` }, CTX);
    expect(
      accounts.map((a) => [a.name, a.kind, a.cardType, a.currency, a.balanceMinor, a.last4]),
    ).toEqual([
      ['EUR balance', 'card', 'wise', 'EUR', 31_086, null],
      ['USD balance', 'card', 'wise', 'USD', 120_450, null],
      ['GBP balance', 'card', 'wise', 'GBP', 8_710, null],
      ['Holiday', 'jar', 'jar', 'EUR', 250_000, null],
    ]);
    expect(accounts[0]?.providerAccountId).toBe(`${FAKE_WISE_PROFILE_ID}:200001`);
    expect(accounts.every((a) => a.creditLimitMinor === 0 && a.goalMinor === null)).toBe(true);
  });

  it('only ever issues GET, and only to the two read paths', async () => {
    const { provider, fake } = rig();
    await provider.connect({ token: FAKE_WISE_TOKEN }, CTX);
    await provider.fetchAccounts(TOKENS, CTX);
    const rows = await provider.fetchTransactions(
      TOKENS,
      { providerAccountId: `${FAKE_WISE_PROFILE_ID}:200001`, currency: 'EUR' },
      { from: '2026-10-01', to: '2026-11-03' },
      CTX,
    );
    expect(rows).toEqual([]);
    expect(fake.requests.length).toBe(4);
    expect(new Set(fake.requests.map((r) => r.method))).toEqual(new Set(['GET']));
    expect(new Set(fake.requests.map((r) => r.path))).toEqual(
      new Set(['/2026Q4/profiles', `/2026Q4/profiles/${FAKE_WISE_PROFILE_ID}/balances`]),
    );
    expect(fake.requests.every((r) => /^Bearer /.test(r.headers['authorization'] ?? ''))).toBe(
      true,
    );
    expect(fake.requests.some((r) => /statement|transfer|quote|recipient/i.test(r.path))).toBe(
      false,
    );
  });

  it('never touches the network for transactions', async () => {
    const { provider, fake } = rig();
    await provider.fetchTransactions(
      TOKENS,
      { providerAccountId: '1:2', currency: 'EUR' },
      { from: '2026-01-01', to: '2026-02-01' },
      CTX,
    );
    expect(fake.requests).toHaveLength(0);
  });

  it('reads amounts as the text Wise wrote, never through a float', async () => {
    const profiles = '[{"type":"PERSONAL","id":7,"currentState":"VISIBLE"}]';
    const balances =
      '[{"id":1,"currency":"EUR","type":"STANDARD","name":null,"visible":true,"amount":{"value":2500.10,"currency":"EUR"}},' +
      '{"id":2,"currency":"JPY","type":"STANDARD","name":null,"amount":{"value":1234,"currency":"JPY"}},' +
      '{"id":3,"currency":"USD","type":"STANDARD","name":null,"amount":{"value":1e-7,"currency":"USD"}},' +
      '{"id":4,"currency":"GBP","type":"STANDARD","name":null,"visible":false,"amount":{"value":9,"currency":"GBP"}}]';
    const { provider, diagnostics } = rig(
      () => (url) => Promise.resolve(new Response(url.includes('/balances') ? balances : profiles)),
    );
    const { accounts } = await provider.connect({ token: 'abc' }, CTX);
    expect(accounts.map((a) => [a.currency, a.balanceMinor])).toEqual([
      ['EUR', 250_010],
      ['JPY', 1234],
    ]);
    expect(
      diagnostics
        .snapshot()
        .warnings.map((w) => w.message)
        .join(),
    ).toMatch(/not a plain decimal/);
  });

  describe('when Wise says no', () => {
    it('turns the real invalid_token answer into a message for the token field', async () => {
      const { provider } = rig();
      await expect(provider.connect({ token: 'x'.repeat(40) }, CTX)).rejects.toMatchObject({
        code: 'validation_failed',
        errors: [{ path: 'token' }],
      });
      await expect(provider.fetchAccounts({ accessToken: 'nope' }, CTX)).rejects.toBeInstanceOf(
        TokenRejectedError,
      );
    });

    it('treats a plain 403 as rejected, and a 403 with X-2FA headers as an explanation, never a signature', async () => {
      const plain = rig(() => answer('{"error":"forbidden"}', 403));
      await expect(plain.provider.fetchAccounts(TOKENS, CTX)).rejects.toBeInstanceOf(
        TokenRejectedError,
      );

      const sca = rig((fake) => {
        fake.strongAuth = true;
        return fake.transport;
      });
      await expect(sca.provider.connect({ token: FAKE_WISE_TOKEN }, CTX)).rejects.toMatchObject({
        code: 'bank_unavailable',
        message: STRONG_AUTH_MESSAGE,
      });
      expect(sca.fake.requests.every((r) => r.method === 'GET')).toBe(true);
      expect(
        sca.fake.requests.some((r) => 'x-2fa-approval' in r.headers || 'x-signature' in r.headers),
      ).toBe(false);
    });

    it('honours Retry-After on a 429 and calls an outage the bank not responding', async () => {
      const limited = rig(() => answer('{}', 429, { 'retry-after': '7' }));
      await expect(limited.provider.fetchAccounts(TOKENS, CTX)).rejects.toMatchObject({
        code: 'rate_limited',
        retryAfterSeconds: 7,
      });
      const down = rig(() => answer('oops', 503));
      await expect(down.provider.fetchAccounts(TOKENS, CTX)).rejects.toMatchObject({
        code: 'bank_unavailable',
      });
      const junk = rig(() => answer('<html>', 200));
      await expect(junk.provider.fetchAccounts(TOKENS, CTX)).rejects.toMatchObject({
        code: 'provider_error',
      });
    });
  });

  it('files calls with the token, the profile and the person hidden, and keeps values out of the diagnostics', async () => {
    const { provider, inspector, diagnostics } = rig();
    await provider.connect({ token: FAKE_WISE_TOKEN }, CTX);
    const text = JSON.stringify(inspector.list('ses_test'));
    for (const secret of [
      FAKE_WISE_TOKEN,
      String(FAKE_WISE_PROFILE_ID),
      'Made',
      'made.up@example.com',
      '1990-01-01',
      '1 Invented Street',
      '+32000000000',
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    const first = inspector.list('ses_test').at(-1);
    expect(first?.request.headers['authorization']).toBe('Bearer [redacted]');
    expect(inspector.list('ses_test').find((c) => c.url.includes('/balances'))?.url).toContain(
      '/profiles/••••/balances',
    );
    expect(text).toContain('"amount"'); // what the drawer is for stays readable
    const diag = JSON.stringify(diagnostics.snapshot());
    for (const secret of [FAKE_WISE_TOKEN, 'Made', '310', 'Holiday', String(FAKE_WISE_PROFILE_ID)])
      expect(diag).not.toContain(secret);
    expect(diag).toContain('currentState');
  });
});

describe('Wise in the app', () => {
  it('counts in Your money, shows no spending, reads as finished and never asks for history', async () => {
    const clock = fixedClock(NOW);
    const fake = wise(clock);
    const t = await createTestApp(
      {},
      {
        clock,
        transports: {
          wise: fake.transport,
          monobank: paced(clock).transport,
          pause: pauseOn(clock),
        },
      },
    );
    try {
      const client = new Client(t);
      await client.start();
      const connected = await client.post('/api/connection', {
        mode: 'token',
        provider: 'wise',
        token: FAKE_WISE_TOKEN,
      });
      expect(connected.statusCode).toBe(201);
      expect(connected.json()).toMatchObject({
        provider: 'wise',
        bank: 'wise',
        label: 'Wise',
        kind: 'api',
      });

      const home = (await client.get('/api/home')).json();
      expect(home.accounts).toHaveLength(4);
      expect(
        home.accounts.every(
          (a: { bank: string; history: { state: string } }) =>
            a.bank === 'wise' && a.history.state === 'done',
        ),
      ).toBe(true);
      expect(home.hero.ownUahMinor).toBeGreaterThan(0);
      expect(home.hero.ownUahMinor).toBe(
        home.accounts.reduce(
          (n: number, a: { ownUahMinor: number | null }) => n + (a.ownUahMinor ?? 0),
          0,
        ),
      );
      expect(home.sync).toMatchObject({ phase: 'idle', done: 0, total: 0, needsToken: false });
      expect(home.month.spentMinor).toBe(0);
      expect(home.trend.points.at(-1)).toBe(home.hero.ownUahMinor); // a flat line at today's balances
      expect((await client.get('/api/activity')).json().rows).toEqual([]);
      expect(t.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sync_jobs')?.n).toBe(0);
      expect(await t.ctx.sync.tick()).toBe(0);
      const refreshed = await client.post('/api/sync/refresh');
      expect(refreshed.statusCode).toBe(200);
      expect(new Set(fake.requests.map((r) => r.method))).toEqual(new Set(['GET']));
      expect(fake.requests.some((r) => r.path.includes('statement'))).toBe(false);
    } finally {
      await t.close();
    }
  });

  it('explains a strong-authentication answer in words instead of retrying or signing', async () => {
    const clock = fixedClock(NOW);
    const fake = wise(clock);
    const t = await createTestApp(
      {},
      { clock, transports: { wise: fake.transport, pause: pauseOn(clock) } },
    );
    try {
      const client = new Client(t);
      await client.start();
      fake.strongAuth = true;
      const response = await client.post('/api/connection', {
        mode: 'token',
        provider: 'wise',
        token: FAKE_WISE_TOKEN,
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().detail).toBe(STRONG_AUTH_MESSAGE);
      expect((await client.get('/api/session')).json().connections).toEqual([]);
    } finally {
      await t.close();
    }
  });
});

describe('migration 003_wise', () => {
  it('rebuilds a database shaped like the one now in use and loses nothing', () => {
    const db = new Db(':memory:');
    migrate(db, migrations.slice(0, 2));
    db.run(
      `INSERT INTO sessions (id, created_at, last_seen_at) VALUES ('s1', '2026-11-01T10:00:00Z', '2026-11-04T10:00:00Z')`,
    );
    for (const [id, provider, kind] of [
      ['con_a', 'monobank', 'api'],
      ['con_b', 'privatbank', 'api'],
      ['con_c', 'privat24', 'file'],
    ] as const) {
      db.run(
        `INSERT INTO connections (id, session_id, provider, kind, status, tokens_enc, created_at, updated_at)
         VALUES (?, 's1', ?, ?, 'active', ?, '2026-11-01T10:00:00Z', '2026-11-01T10:00:00Z')`,
        id,
        provider,
        kind,
        kind === 'api' ? `v1.k1.sealed-${id}.x.y` : null,
      );
      db.run(
        `INSERT INTO accounts (id, connection_id, provider_account_id, kind, card_type, name, currency, balance_minor, balance_at, balance_known)
         VALUES (?, ?, ?, 'card', 'black', 'A', 'UAH', 100, '2026-11-04T09:00:00Z', 1)`,
        `acc_${id}`,
        id,
        `p_${id}`,
      );
      db.run(
        `INSERT INTO transactions (id, account_id, provider_txn_id, ts, status, amount_minor, currency, description, category, category_source)
         VALUES (?, ?, 't1', 1700000000000, 'booked', -5, 'UAH', 'x', 'other', 'auto')`,
        `txn_${id}`,
        `acc_${id}`,
      );
    }
    const before = db.all('SELECT * FROM connections WHERE 1 = 1 ORDER BY id');
    expect(migrate(db)).toEqual(['003_wise', '004_fop_rows']);
    expect(db.all('SELECT * FROM connections WHERE 2 = 2 ORDER BY id')).toEqual(before);
    for (const table of ['accounts', 'transactions']) {
      expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n).toBe(3);
    }
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
    const add = (id: string, provider: string) =>
      db.run(
        `INSERT INTO connections (id, session_id, provider, status, created_at, updated_at) VALUES (?, 's1', ?, 'active', 'n', 'n')`,
        id,
        provider,
      );
    add('con_w', 'wise');
    expect(() => add('con_x', 'wise')).toThrow(); // one connection per bank
    expect(() => add('con_y', 'unknown')).toThrow();
    db.run(`DELETE FROM sessions WHERE id = 's1'`);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM transactions')?.n).toBe(0);
    db.close();
  });
});
