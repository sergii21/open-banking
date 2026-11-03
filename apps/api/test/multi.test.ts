import { afterEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/clock';
import type { Transport } from '../src/providers/transport';
import { ROUTINE_MESSAGE } from '../src/providers/privatbank/adapter';
import {
  Client,
  DEMO_TOKEN,
  FAKE_PRIVAT_TOKEN,
  NOW,
  createTestApp,
  paced,
  pauseOn,
  privat,
  type TestApp,
} from './helpers';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const MINUTE = 60_000;

/** monobank (one read a minute) and PrivatBank (one request a second) in one session, on one test clock. */
async function twoBanks(options: { privatTransport?: (inner: Transport) => Transport } = {}) {
  const clock = fixedClock(NOW);
  const mono = paced(clock, { statementMs: MINUTE, infoMs: MINUTE });
  const bank = privat(clock);
  t = await createTestApp(
    { MONOBANK_MIN_INTERVAL_SECONDS: '60', PRIVATBANK_MIN_INTERVAL_MS: '1100' },
    {
      clock,
      transports: {
        monobank: mono.transport,
        privatbank: options.privatTransport
          ? options.privatTransport(bank.transport)
          : bank.transport,
        pause: pauseOn(clock),
      },
    },
  );
  const client = new Client(t);
  await client.start();
  const monoResponse = await client.post('/api/connection', {
    mode: 'token',
    provider: 'monobank',
    token: DEMO_TOKEN,
  });
  expect(monoResponse.statusCode).toBe(201);
  clock.advance(MINUTE + 1000); // monobank allows one check a minute; the next bank is another service
  const privatResponse = await client.post('/api/connection', {
    mode: 'token',
    provider: 'privatbank',
    token: FAKE_PRIVAT_TOKEN,
  });
  expect(privatResponse.statusCode).toBe(201);
  return {
    t,
    client,
    clock,
    mono,
    bank,
    ids: { mono: monoResponse.json().id as string, privat: privatResponse.json().id as string },
  };
}

describe('several banks in one session', () => {
  it('lists every connection, sums every account into one number, and says which bank each account is at', async () => {
    const { client } = await twoBanks();
    const session = (await client.get('/api/session')).json();
    expect(
      session.connections.map((c: { provider: string; kind: string; bank: string }) => [
        c.provider,
        c.kind,
        c.bank,
      ]),
    ).toEqual([
      ['monobank', 'api', 'monobank'],
      ['privatbank', 'api', 'privatbank'],
    ]);
    expect(session.connections[1]).toMatchObject({
      label: 'PrivatBank business',
      demo: false,
      status: 'active',
    });

    const home = (await client.get('/api/home')).json();
    const banks = new Set(home.accounts.map((a: { bank: string }) => a.bank));
    expect(banks).toEqual(new Set(['monobank', 'privatbank']));
    const privatAccounts = home.accounts.filter((a: { bank: string }) => a.bank === 'privatbank');
    expect(privatAccounts).toHaveLength(2);
    expect(
      privatAccounts.every(
        (a: { type: string; source: string }) => a.type === 'business' && a.source === 'api',
      ),
    ).toBe(true);
    const sum = home.accounts.reduce(
      (n: number, a: { ownUahMinor: number | null }) => n + (a.ownUahMinor ?? 0),
      0,
    );
    expect(home.hero.ownUahMinor).toBe(sum);
    expect(home.demo).toBe(false);
  });

  it('loads each bank at its own pace and never mixes one bank’s limit into the other’s', async () => {
    const { t, client, clock, bank } = await twoBanks();
    const total = (await client.get('/api/sync')).json().total;
    expect(total).toBeGreaterThan(10);

    // PrivatBank's gate is shut for a second after connecting; monobank's statement gate is open.
    expect(await t.ctx.sync.tick()).toBe(1);
    clock.advance(1200);
    expect(await t.ctx.sync.tick()).toBe(1); // PrivatBank's turn (monobank waits its minute)
    expect(await t.ctx.sync.tick()).toBe(0);
    clock.advance(1200);
    expect(await t.ctx.sync.tick()).toBe(1);

    const activity = (await client.get('/api/activity')).json();
    const bankOf = new Map<string, string>(
      activity.accounts.map((a: { id: string; bank: string }) => [a.id, a.bank]),
    );
    const seen = new Set(activity.rows.map((r: { accountId: string }) => bankOf.get(r.accountId)));
    expect(seen).toEqual(new Set(['monobank', 'privatbank']));

    // The PrivatBank requests were never closer than the bank's second, across connecting and loading.
    const gaps = bank.requests.slice(1).map((r, i) => r.at - (bank.requests[i]?.at ?? 0));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(1000);

    const state = (await client.get('/api/sync')).json();
    expect(state.total).toBe(total);
    expect(state.done).toBe(3);
  });

  it('shows holds from the interim statement and leaves out the items that never moved money', async () => {
    const { t, client, clock } = await twoBanks();
    for (let i = 0; i < 3; i += 1) {
      await t.ctx.sync.tick();
      clock.advance(1200);
    }
    const activity = (await client.get('/api/activity')).json();
    const privatIds = new Set(
      activity.accounts
        .filter((a: { bank: string }) => a.bank === 'privatbank')
        .map((a: { id: string }) => a.id),
    );
    const rows = activity.rows.filter((r: { accountId: string }) => privatIds.has(r.accountId));
    expect(rows.some((r: { status: string }) => r.status === 'pending')).toBe(true);
    expect(
      rows.some((r: { description: string }) =>
        /Сторнована|Забракований|Інформаційна/.test(r.description),
      ),
    ).toBe(false);
    // Business income is income, not "other".
    expect(
      rows.some(
        (r: { category: string; amountMinor: number }) =>
          r.category === 'income' && r.amountMinor > 0,
      ),
    ).toBe(true);
  });

  it('removes one bank with everything read through it and leaves the other loading', async () => {
    const { t, client, ids } = await twoBanks();
    await t.ctx.sync.tick();
    expect((await client.delete(`/api/connection/${ids.privat}`)).statusCode).toBe(204);

    const session = (await client.get('/api/session')).json();
    expect(session.connections).toHaveLength(1);
    expect(session.connections[0].provider).toBe('monobank');
    const home = (await client.get('/api/home')).json();
    expect(home.accounts.every((a: { bank: string }) => a.bank === 'monobank')).toBe(true);
    expect(
      t.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM sync_jobs WHERE connection_id = ?`,
        ids.privat,
      )?.n,
    ).toBe(0);
    const calls = (await client.get('/api/inspector/calls')).json().items as { provider: string }[];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.some((c) => c.provider === 'privatbank')).toBe(false);
    expect((await client.get('/api/sync')).json().total).toBeGreaterThan(0);

    // The last one: the screens fall back to the first-run state.
    expect((await client.delete(`/api/connection/${ids.mono}`)).statusCode).toBe(204);
    expect((await client.get('/api/session')).json().connections).toEqual([]);
    expect((await client.get('/api/home')).statusCode).toBe(404);
  });

  it('asks for a new token for the one bank that stopped accepting it, and the other carries on', async () => {
    let revoked = false;
    const { t, client, clock, ids } = await twoBanks({
      privatTransport: (inner) => (url, init) =>
        revoked && new URL(url).pathname.includes('/transactions')
          ? Promise.resolve(
              new Response(JSON.stringify({ status: 'ERROR', message: 'no' }), { status: 401 }),
            )
          : inner(url, init),
    });
    revoked = true;
    clock.advance(2000);
    await t.ctx.sync.tick();

    const state = (await client.get('/api/sync')).json();
    expect(state).toMatchObject({ phase: 'attention', needsToken: true });
    expect(state.message).toBe('PrivatBank no longer accepts your token. Paste a new one.');
    const connections = (await client.get('/api/session')).json().connections;
    expect(connections.map((c: { status: string }) => c.status)).toEqual([
      'active',
      'needs_reauth',
    ]);

    // Refreshing still works for the bank that is fine.
    clock.advance(MINUTE);
    expect((await client.post('/api/sync/refresh')).statusCode).toBe(200);

    revoked = false;
    const replaced = await client.put(`/api/connection/${ids.privat}/token`, {
      token: FAKE_PRIVAT_TOKEN,
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json()).toMatchObject({ id: ids.privat, status: 'active' });
    expect((await client.get('/api/session')).json().connections).toHaveLength(2);
  });

  it('says PrivatBank is in its daily routine, keeps what it has, and picks up when it is over', async () => {
    const { t, client, clock, bank } = await twoBanks();
    await t.ctx.sync.tick();
    clock.advance(1200);
    await t.ctx.sync.tick();
    const before = (await client.get('/api/activity')).json().rows.length;

    bank.routine = true;
    clock.advance(1200);
    await t.ctx.sync.tick();
    const attention = (await client.get('/api/sync')).json();
    expect(attention.phase).toBe('attention');
    expect(attention.needsToken).toBe(false);
    expect(attention.message).toBe(ROUTINE_MESSAGE);
    expect((await client.get('/api/activity')).json().rows.length).toBe(before);

    bank.routine = false;
    clock.advance(31_000);
    await t.ctx.sync.tick();
    expect((await client.get('/api/sync')).json().message).toBeNull();
  });

  it('turns a PrivatBank key the bank does not know into a message for the field and stores nothing', async () => {
    const clock = fixedClock(NOW);
    t = await createTestApp(
      {},
      { clock, transports: { privatbank: privat(clock).transport, pause: pauseOn(clock) } },
    );
    const client = new Client(t);
    await client.start();
    const response = await client.post('/api/connection', {
      mode: 'token',
      provider: 'privatbank',
      token: 'x'.repeat(44),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'validation_failed',
      errors: [{ path: 'token' }],
    });
    expect((await client.get('/api/session')).json().connections).toEqual([]);
    expect(t.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM accounts')?.n).toBe(0);
  });

  describe('the demo', () => {
    it('is replaced by a real bank, never added to one', async () => {
      const clock = fixedClock(NOW);
      t = await createTestApp(
        {},
        { clock, transports: { privatbank: privat(clock).transport, pause: pauseOn(clock) } },
      );
      const client = new Client(t);
      await client.start();
      expect((await client.post('/api/connection', { mode: 'demo' })).statusCode).toBe(201);
      expect((await client.get('/api/home')).json().demo).toBe(true);

      const real = await client.post('/api/connection', {
        mode: 'token',
        provider: 'privatbank',
        token: FAKE_PRIVAT_TOKEN,
      });
      expect(real.statusCode).toBe(201);
      const connections = (await client.get('/api/session')).json().connections;
      expect(connections.map((c: { provider: string }) => c.provider)).toEqual(['privatbank']);
      expect((await client.get('/api/home')).json().demo).toBe(false);
    });

    it('is refused while a real bank is connected', async () => {
      const clock = fixedClock(NOW);
      t = await createTestApp(
        {},
        { clock, transports: { privatbank: privat(clock).transport, pause: pauseOn(clock) } },
      );
      const client = new Client(t);
      await client.start();
      await client.post('/api/connection', {
        mode: 'token',
        provider: 'privatbank',
        token: FAKE_PRIVAT_TOKEN,
      });
      const demo = await client.post('/api/connection', { mode: 'demo' });
      expect(demo.statusCode).toBe(409);
      expect(demo.json().code).toBe('conflict');
    });
  });

  it('keeps real banks off a public instance', async () => {
    t = await createTestApp({ PUBLIC_URL: 'https://ledger.example.com' });
    const client = new Client(t);
    await client.start();
    const response = await client.post('/api/connection', {
      mode: 'token',
      provider: 'privatbank',
      token: FAKE_PRIVAT_TOKEN,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('provider_not_available');
    expect((await client.post('/api/connection', { mode: 'demo' })).statusCode).toBe(201);
  });
});
