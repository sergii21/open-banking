import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, newClient, type TestApp } from './helpers';

let t: TestApp;
afterEach(async () => {
  await t.close();
});

const PAYMENT = {
  institutionId: 'mock:mock-bank',
  amountMinor: 100,
  currency: 'EUR',
  beneficiary: { type: 'iban', name: 'Erika Mustermann', iban: 'DE89370400440532013000' },
  reference: 'Limit',
};

describe('starting sessions', () => {
  it('caps how many an address may start per minute, and lets it start again a minute later', async () => {
    t = await createTestApp({ sessionCreatesPerMinute: 3 });
    const start = (address: string) =>
      t.app.inject({ method: 'GET', url: '/api/session', remoteAddress: address });

    for (let i = 0; i < 3; i += 1) expect((await start('203.0.113.10')).statusCode).toBe(200);
    const refused = await start('203.0.113.10');
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 60 });
    // Nothing was created for the refused request.
    expect(t.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions')?.n).toBe(3);

    // Someone else is unaffected, and the wait is real: a minute later the first address may start another.
    expect((await start('203.0.113.99')).statusCode).toBe(200);
    t.clock.advance(61_000);
    expect((await start('203.0.113.10')).statusCode).toBe(200);
  });

  it('does not count a browser that already has a session', async () => {
    t = await createTestApp({ sessionCreatesPerMinute: 1 });
    const client = await newClient(t);
    for (let i = 0; i < 5; i += 1) expect((await client.get('/api/session')).statusCode).toBe(200);
  });
});

describe('limits on the routes that cost something', () => {
  it('payments: ten attempts a minute per session, and one customer cannot use up another’s', async () => {
    t = await createTestApp();
    const client = await newClient(t);
    const other = await newClient(t);

    const statuses: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      statuses.push((await client.createPayment({ ...PAYMENT, amountMinor: 100 + i })).statusCode);
    }
    expect(statuses.slice(0, 10).every((status) => status === 201)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);

    const refused = await client.createPayment({ ...PAYMENT, amountMinor: 999 });
    expect(refused.json()).toMatchObject({ code: 'rate_limited' });
    expect(refused.headers['retry-after']).toBeTruthy();

    expect((await other.createPayment(PAYMENT)).statusCode).toBe(201);
  });

  it('the spreadsheet download: twenty a minute', async () => {
    t = await createTestApp();
    const client = await newClient(t);
    const statuses: number[] = [];
    for (let i = 0; i < 22; i += 1)
      statuses.push((await client.get('/api/transactions/export.csv')).statusCode);
    expect(statuses.slice(0, 20).every((status) => status === 200)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
  });

  it('webhooks: a flood from one address is cut off, but only after a generous allowance', async () => {
    t = await createTestApp();
    const send = () =>
      t.app.inject({
        method: 'POST',
        url: '/api/webhooks/mock',
        headers: { 'content-type': 'application/json' },
        payload: '{}',
        remoteAddress: '198.51.100.7',
      });
    let last = 0;
    let firstRefusal = -1;
    for (let i = 0; i < 320; i += 1) {
      last = (await send()).statusCode;
      if (last === 429 && firstRefusal < 0) firstRefusal = i;
    }
    expect(firstRefusal).toBe(300); // 300 unsigned requests are refused as unsigned (401), the 301st as too many
    expect(last).toBe(429);
  });
});

describe('what the browser may keep', () => {
  it('tells browsers and proxies not to store anything per-customer under /api', async () => {
    t = await createTestApp();
    const client = await newClient(t);
    for (const url of [
      '/api/session',
      '/api/meta',
      '/api/institutions',
      '/api/connections',
      '/api/accounts',
      '/api/transactions',
      '/api/payments',
      '/api/insights/summary',
      '/api/inspector/calls',
      '/api/nope',
    ]) {
      const response = await client.get(url);
      expect(response.headers['cache-control'], url).toBe('no-store');
    }
  });

  it('marks the session cookie HttpOnly and SameSite=Lax, and the XSRF cookie readable by the page', async () => {
    t = await createTestApp();
    const response = await t.app.inject({ method: 'GET', url: '/api/session' });
    const cookies = [response.headers['set-cookie']].flat().map(String);
    const session = cookies.find((cookie) => cookie.startsWith('ll_sid='));
    const xsrf = cookies.find((cookie) => cookie.startsWith('XSRF-TOKEN='));
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(xsrf).not.toMatch(/HttpOnly/i);
    expect(xsrf).toMatch(/SameSite=Lax/i);
  });

  it('over https the cookies are Secure and pinned to the exact host (__Host- prefix, no Domain)', async () => {
    t = await createTestApp({ publicUrl: 'https://demo.example', secureCookies: true });
    const response = await t.app.inject({ method: 'GET', url: '/api/session' });
    const cookies = [response.headers['set-cookie']].flat().map(String);
    const session = cookies.find((cookie) => cookie.startsWith('__Host-ll_sid='));
    expect(session).toBeTruthy();
    expect(session).toMatch(/Secure/i);
    expect(session).toMatch(/Path=\//);
    expect(session).not.toMatch(/Domain=/i);
    expect(response.headers['strict-transport-security']).toBeTruthy();
  });

  it('refuses cross-site writes: no token, a token from another session, and a foreign Origin', async () => {
    t = await createTestApp();
    const client = await newClient(t);
    const stranger = await newClient(t);

    const none = await client.post('/api/payments', PAYMENT, {
      csrf: false,
      headers: { 'idempotency-key': 'csrf-test-key-1' },
    });
    expect(none.statusCode).toBe(403);

    const foreignToken = stranger.cookies.get('XSRF-TOKEN') ?? '';
    const wrongSession = await client.post('/api/payments', PAYMENT, {
      csrf: false,
      headers: { 'idempotency-key': 'csrf-test-key-2', 'x-xsrf-token': foreignToken },
    });
    expect(wrongSession.statusCode).toBe(403);

    const foreignOrigin = await client.post('/api/payments', PAYMENT, {
      headers: { 'idempotency-key': 'csrf-test-key-3', origin: 'https://evil.example' },
    });
    expect(foreignOrigin.statusCode).toBe(403);
    expect(foreignOrigin.json()).toMatchObject({ code: 'csrf_failed' });
  });
});
