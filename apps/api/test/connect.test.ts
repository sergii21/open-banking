import { afterEach, describe, expect, it } from 'vitest';
import { AccountList, ConnectionList, TransactionPage } from '@ledger-lens/contracts';
import { createTestApp, newClient, type TestApp } from './helpers';

let t: TestApp;
afterEach(async () => {
  await t.close();
});

describe('session and CSRF', () => {
  it('requires a session for the API and bootstraps one on /api/session', async () => {
    t = await createTestApp();
    const anonymous = await t.app.inject({ method: 'GET', url: '/api/accounts' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json()).toMatchObject({ code: 'session_required' });

    const client = await newClient(t);
    expect(client.cookies.has('ll_sid')).toBe(true);
    expect(client.cookies.has('XSRF-TOKEN')).toBe(true);
    expect((await client.get('/api/accounts')).statusCode).toBe(200);
  });

  it('stores only a hash of the session token and keeps the cookie HttpOnly', async () => {
    t = await createTestApp();
    const response = await t.app.inject({ method: 'GET', url: '/api/session' });
    const sid = response.cookies.find((c) => c.name === 'll_sid');
    expect(sid).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    const xsrf = response.cookies.find((c) => c.name === 'XSRF-TOKEN');
    expect(xsrf?.httpOnly).toBeFalsy();

    const rows = t.db.all<{ id: string }>('SELECT id FROM sessions');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).not.toBe(sid?.value);
    expect(rows[0]?.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects mutating requests without a valid XSRF header or from another origin', async () => {
    t = await createTestApp();
    const client = await newClient(t);
    const body = { institutionId: 'mock:mock-bank' };

    const missing = await client.post('/api/connections', body, { csrf: false });
    expect(missing.statusCode).toBe(403);
    expect(missing.json()).toMatchObject({ code: 'csrf_failed' });

    const wrong = await client.post('/api/connections', body, {
      csrf: false,
      headers: { 'x-xsrf-token': 'nope' },
    });
    expect(wrong.statusCode).toBe(403);

    const foreign = await client.post('/api/connections', body, {
      headers: { origin: 'https://evil.example' },
    });
    expect(foreign.statusCode).toBe(403);

    const ok = await client.post('/api/connections', body, {
      headers: { origin: 'http://localhost:4200' },
    });
    expect(ok.statusCode).toBe(201);
  });

  it('ties the XSRF token to its session', async () => {
    t = await createTestApp();
    const a = await newClient(t);
    const b = await newClient(t);
    const tokenOfA = a.cookies.get('XSRF-TOKEN') as string;
    const response = await b.post(
      '/api/connections',
      { institutionId: 'mock:mock-bank' },
      {
        csrf: false,
        headers: { 'x-xsrf-token': tokenOfA },
      },
    );
    expect(response.statusCode).toBe(403);
  });
});

describe('connecting the mock bank', () => {
  it('walks the hosted consent journey and caches accounts, balances and transactions', async () => {
    t = await createTestApp();
    const client = await newClient(t);

    const outcome = await client.connectBank();
    expect(outcome.status).toBe('success');
    expect(outcome.connection).toBe(outcome.connectionId);

    const connections = ConnectionList.parse((await client.get('/api/connections')).json());
    expect(connections.items).toHaveLength(1);
    expect(connections.items[0]).toMatchObject({
      institutionName: 'Mock Bank',
      provider: 'mock',
      mode: 'mock',
      status: 'active',
      consentState: 'valid',
      accountCount: 3,
    });

    const accounts = AccountList.parse((await client.get('/api/accounts')).json());
    expect(accounts.items.map((a) => a.name).sort()).toEqual([
      'Girokonto',
      'Tagesgeld',
      'Visa Gold',
    ]);
    const giro = accounts.items.find((a) => a.name === 'Girokonto');
    expect(giro?.balance).toEqual({ amountMinor: 284_013, currency: 'EUR' });
    expect(giro?.maskedIdentifier).toMatch(/^DE•• •••• •••• \d{4}$/);

    const page = TransactionPage.parse((await client.get('/api/transactions?limit=200')).json());
    expect(page.total).toBeGreaterThan(300);
    expect(page.items).toHaveLength(200);
    expect(page.items.some((x) => x.status === 'pending')).toBe(true);
    expect(page.items.some((x) => x.category === 'groceries')).toBe(true);
    const salary = page.items.find((x) => x.description.startsWith('GEHALT'));
    expect(salary).toMatchObject({
      category: 'income',
      amount: { amountMinor: 345_000, currency: 'EUR' },
    });
  });

  it('pages through transactions with a cursor and no duplicates', async () => {
    t = await createTestApp();
    const client = await newClient(t);
    await client.connectBank();

    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/api/transactions?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = TransactionPage.parse((await client.get(url)).json());
      for (const item of page.items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 50);

    const total = TransactionPage.parse(
      (await client.get('/api/transactions?limit=1')).json(),
    ).total;
    expect(seen.size).toBe(total);
    expect(pages).toBeGreaterThan(2);
  });

  it('filters by search text, category, direction, amount and date', async () => {
    t = await createTestApp();
    const client = await newClient(t);
    await client.connectBank();

    const search = TransactionPage.parse(
      (await client.get('/api/transactions?q=netflix&limit=200')).json(),
    );
    expect(search.items.length).toBeGreaterThan(5);
    expect(
      search.items.every((x) => /netflix/i.test(`${x.description} ${x.counterparty ?? ''}`)),
    ).toBe(true);

    const subs = TransactionPage.parse(
      (await client.get('/api/transactions?category=subscriptions&limit=200')).json(),
    );
    expect(subs.items.every((x) => x.category === 'subscriptions')).toBe(true);

    const incoming = TransactionPage.parse(
      (await client.get('/api/transactions?direction=in&limit=200')).json(),
    );
    expect(incoming.items.every((x) => x.amount.amountMinor > 0)).toBe(true);

    const large = TransactionPage.parse(
      (await client.get('/api/transactions?minAmountMinor=100000&limit=200')).json(),
    );
    expect(large.items.length).toBeGreaterThan(0);
    expect(large.items.every((x) => Math.abs(x.amount.amountMinor) >= 100_000)).toBe(true);

    const october = TransactionPage.parse(
      (await client.get('/api/transactions?from=2026-10-01&to=2026-10-31&limit=200')).json(),
    );
    expect(october.items.every((x) => x.bookedAt.startsWith('2026-10'))).toBe(true);

    const bad = await client.get('/api/transactions?from=2026-10-31&to=2026-10-01');
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'validation_failed' });

    // % and _ are literals in search, not wildcards.
    const wild = TransactionPage.parse(
      (await client.get('/api/transactions?q=%25&limit=50')).json(),
    );
    expect(wild.total).toBe(0);
  });

  it('works for the GBP bank too and keeps currencies separate', async () => {
    t = await createTestApp();
    const client = await newClient(t);
    expect((await client.connectBank()).status).toBe('success');
    expect((await client.connectBank({ institutionId: 'mock:mock-bank-uk' })).status).toBe(
      'success',
    );

    const accounts = AccountList.parse((await client.get('/api/accounts')).json());
    expect(new Set(accounts.items.map((a) => a.currency))).toEqual(new Set(['EUR', 'GBP']));
    const everyday = accounts.items.find((a) => a.name === 'Everyday Account');
    expect(everyday?.balance).toEqual({ amountMinor: 196_348, currency: 'GBP' });
    expect(everyday?.maskedIdentifier).toMatch(/^GB•• •••• •••• \d{4}$/);
  });
});

describe('designed failure states during consent', () => {
  it('reports a denied consent and leaves nothing behind', async () => {
    t = await createTestApp();
    const client = await newClient(t);
    const outcome = await client.connectBank({ decision: 'deny' });
    expect(outcome.status).toBe('denied');
    expect(ConnectionList.parse((await client.get('/api/connections')).json()).items).toHaveLength(
      0,
    );
    expect(t.db.all('SELECT id FROM connections')).toHaveLength(0);
  });

  it('reports an SCA timeout', async () => {
    t = await createTestApp();
    const client = await newClient(t);
    expect((await client.connectBank({ persona: 'sca_timeout' })).status).toBe('timeout');
    expect(t.db.all('SELECT id FROM connections')).toHaveLength(0);
  });

  it('reports a bank outage, both for an outage persona and for a degraded bank', async () => {
    t = await createTestApp();
    const client = await newClient(t);
    expect((await client.connectBank({ persona: 'bank_down' })).status).toBe('unavailable');
    expect((await client.connectBank({ institutionId: 'mock:mock-bank-unhealthy' })).status).toBe(
      'unavailable',
    );
  });

  it('rejects a callback with an unknown or reused state', async () => {
    t = await createTestApp();
    const client = await newClient(t);
    const unknown = await t.app.inject({
      method: 'GET',
      url: '/api/connections/callback?code=x&state=unknown',
    });
    expect(unknown.statusCode).toBe(302);
    expect(unknown.headers['location']).toBe('/connect/result?status=invalid_state');

    const ok = await client.connectBank();
    expect(ok.status).toBe('success');
    const state = (
      t.db.get<{ state: string | null }>('SELECT state FROM connections') ?? { state: null }
    ).state;
    expect(state).toBeNull(); // single use: cleared on success
  });

  it('refuses to start a connection with an unknown bank or against a mismatched reconnect', async () => {
    t = await createTestApp();
    const client = await newClient(t);
    const unknown = await client.post('/api/connections', { institutionId: 'mock:nope' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ code: 'provider_not_available' });
    const wrongProvider = await client.post('/api/connections', {
      institutionId: 'truelayer:mock',
    });
    expect(wrongProvider.statusCode).toBe(404);
  });

  it('does not accept an unregistered redirect URI at the bank', async () => {
    t = await createTestApp();
    const authorize = new URLSearchParams({
      response_type: 'code',
      client_id: 'ledger-lens-mock',
      redirect_uri: 'https://evil.example/steal',
      state: 'abcdefgh',
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'S256',
      provider: 'mock-bank',
    });
    const response = await t.app.inject({
      method: 'GET',
      url: `/mock-bank/auth/?${authorize.toString()}`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('redirect URI is not registered');
  });
});
