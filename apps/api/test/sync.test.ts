import { afterEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/clock';
import type { Transport } from '../src/providers/transport';
import { Client, DEMO_TOKEN, NOW, createTestApp, paced, type TestApp } from './helpers';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const MINUTE = 60_000;

async function connectLive(transport: Transport, clock = fixedClock(NOW)) {
  t = await createTestApp(
    { MONOBANK_MIN_INTERVAL_SECONDS: '60' },
    { clock, transports: { monobank: transport } },
  );
  const client = new Client(t);
  await client.start();
  const response = await client.post('/api/connection', { mode: 'token', token: DEMO_TOKEN });
  expect(response.statusCode).toBe(201);
  return { t, client, clock };
}

const coveredCards = (app: TestApp): string[] =>
  app.ctx.repos.accounts
    .listBySession(app.db.get<{ id: string }>('SELECT id FROM sessions')?.id ?? '')
    .filter((a) => a.coveredFrom !== null)
    .map((a) => a.cardType);

describe('loading history inside monobank’s one-read-a-minute limit', () => {
  it('shows balances from the single read at connect, then reads the main card first and one window a minute', async () => {
    const clock = fixedClock(NOW);
    const bank = paced(clock, { statementMs: MINUTE, infoMs: MINUTE });
    const { t, client } = await connectLive(bank.transport, clock);

    const home = (await client.get('/api/home')).json();
    expect(home.accounts).toHaveLength(6);
    expect(home.hero.ownUahMinor).toBeGreaterThan(0);
    expect(home.sync.total).toBeGreaterThan(6);
    expect(home.sync.done).toBe(0);
    expect(home.trend).toBeNull(); // nothing is shown that history has not earned
    expect(home.month.previousSameDaysMinor).toBeNull();

    expect(await t.ctx.sync.tick()).toBe(1);
    expect(coveredCards(t)).toEqual(['black']); // the main hryvnia card first
    expect(await t.ctx.sync.tick()).toBe(0); // the gate is shut
    const waiting = (await client.get('/api/sync')).json();
    expect(waiting).toMatchObject({ phase: 'waiting', done: 1 });
    expect(Date.parse(waiting.nextAt) - clock.now().getTime()).toBeGreaterThan(55_000);

    clock.advance(30_000);
    expect(await t.ctx.sync.tick()).toBe(0);
    clock.advance(31_000);
    expect(await t.ctx.sync.tick()).toBe(1);
    expect(coveredCards(t).sort()).toEqual(['black', 'platinum']);

    // The newest window of every card comes before any older window of the main card.
    const queued = t.db.all<{ account_id: string; window_from: string; priority: number }>(
      `SELECT account_id, window_from, priority FROM sync_jobs WHERE status = 'pending' ORDER BY priority`,
    );
    expect(queued.length).toBeGreaterThan(0);
    expect(queued[0]?.priority).toBeLessThan(100);
  });

  it('learns from a 429 right after the account list that the two limits are one, and waits', async () => {
    const clock = fixedClock(NOW);
    const bank = paced(clock, { statementMs: MINUTE, infoMs: MINUTE, shared: true });
    const { t, client } = await connectLive(bank.transport, clock);

    expect(await t.ctx.sync.tick()).toBe(0); // the bank said 429: the first statement waits a minute
    const state = (await client.get('/api/sync')).json();
    expect(state.phase).toBe('waiting');
    expect(Date.parse(state.nextAt) - clock.now().getTime()).toBeGreaterThan(55_000);

    clock.advance(61_000);
    expect(await t.ctx.sync.tick()).toBe(1);
    // A refresh now has to wait for the balance read as well: one shared limit.
    const refreshed = await client.post('/api/sync/refresh');
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().balancesNextAt).not.toBeNull();
  });

  it('asks for the rest of a window the bank cut at 500 rows, right behind it', async () => {
    const clock = fixedClock(NOW);
    const bank = paced(clock);
    const day = 86_400;
    const nowSeconds = Math.floor(clock.now().getTime() / 1000);
    let statementCalls = 0;
    const page: Transport = (url, init) => {
      const path = new URL(url).pathname;
      if (!path.startsWith('/personal/statement/')) return bank.transport(url, init);
      statementCalls += 1;
      const [, , , , from, to] = path.split('/').map(String);
      // 500 rows packed into the newest 20 days of the window, then the rest on the second call.
      const count = statementCalls === 1 ? 500 : 40;
      const top = statementCalls === 1 ? Number(to) : nowSeconds - 20 * day;
      const rows = Array.from({ length: count }, (_, i) => ({
        id: `r${statementCalls}-${i}`,
        time: Math.max(Number(from), top - i * 3000),
        description: 'Сільпо',
        mcc: 5411,
        amount: -1000,
        currencyCode: 980,
        balance: 100000 - i,
      }));
      return Promise.resolve(
        new Response(JSON.stringify(rows), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    };
    const { t } = await connectLive(page, clock);
    expect(await t.ctx.sync.tick()).toBe(1);
    const next = t.db.get<{ window_from: string; window_to: string; priority: number }>(
      `SELECT window_from, window_to, priority FROM sync_jobs WHERE status = 'pending' ORDER BY priority LIMIT 1`,
    );
    const first = t.db.get<{ covered_from: string }>(
      `SELECT covered_from FROM accounts WHERE card_type = 'black'`,
    );
    // The loaded span starts where the 500th row is, not where the window started, and that same span is what is queued next.
    expect(first?.covered_from).toBe(next?.window_to);
    expect(next?.priority).toBeLessThan(10.01);
  });
});

describe('when something goes wrong', () => {
  it('says the bank is not responding, keeps what it has, and picks up again when it is back', async () => {
    const clock = fixedClock(NOW);
    const bank = paced(clock);
    const { t, client } = await connectLive(bank.transport, clock);
    expect(await t.ctx.sync.tick()).toBeGreaterThan(0);
    bank.down = true;
    clock.advance(MINUTE);
    t.ctx.repos.syncJobs.enqueue(
      {
        connectionId: t.ctx.repos.connections.listActive()[0]?.id ?? '',
        accountId:
          t.ctx.repos.accounts.listBySession(
            t.db.get<{ id: string }>('SELECT id FROM sessions')?.id ?? '',
          )[0]?.id ?? '',
        kind: 'topup',
        from: '2026-11-01',
        to: '2026-11-03',
        priority: 1,
      },
      clock.now().toISOString(),
    );
    await t.ctx.sync.tick();
    const attention = (await client.get('/api/sync')).json();
    expect(attention).toMatchObject({ phase: 'attention', needsToken: false });
    expect(attention.message).toMatch(/not responding/);
    const activity = (await client.get('/api/activity')).json();
    expect(activity.rows.length).toBeGreaterThan(0); // what was loaded is still there

    bank.down = false;
    clock.advance(31_000);
    await t.ctx.sync.tick();
    expect((await client.get('/api/sync')).json().phase).not.toBe('attention');
  });

  it('stops and asks for a new token when monobank no longer accepts it, and keeps history when one is pasted', async () => {
    const clock = fixedClock(NOW);
    const bank = paced(clock);
    let revoked = false;
    const transport: Transport = (url, init) =>
      revoked && new URL(url).pathname.startsWith('/personal/statement')
        ? Promise.resolve(
            new Response(JSON.stringify({ errorDescription: "Unknown 'X-Token'" }), {
              status: 403,
              headers: { 'content-type': 'application/json' },
            }),
          )
        : bank.transport(url, init);
    const { t, client } = await connectLive(transport, clock);
    await t.ctx.sync.tick();
    const stored = (await client.get('/api/activity')).json().rows.length;
    expect(stored).toBeGreaterThan(0);

    revoked = true;
    clock.advance(MINUTE);
    t.ctx.repos.syncJobs.enqueue(
      {
        connectionId: t.ctx.repos.connections.listActive()[0]?.id ?? '',
        accountId:
          t.ctx.repos.accounts.listBySession(
            t.db.get<{ id: string }>('SELECT id FROM sessions')?.id ?? '',
          )[0]?.id ?? '',
        kind: 'topup',
        from: '2026-11-01',
        to: '2026-11-03',
        priority: 0,
      },
      clock.now().toISOString(),
    );
    await t.ctx.sync.tick();
    const state = (await client.get('/api/sync')).json();
    expect(state).toMatchObject({ phase: 'attention', needsToken: true });
    const session = (await client.get('/api/session')).json();
    expect(session.connections[0].status).toBe('needs_reauth');

    revoked = false;
    clock.advance(MINUTE);
    const replaced = await client.put(`/api/connection/${session.connections[0].id}/token`, {
      token: DEMO_TOKEN,
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().status).toBe('active');
    expect((await client.get('/api/activity')).json().rows.length).toBe(stored);
  });

  it('turns a wrong token into a message for the token field and stores nothing', async () => {
    const clock = fixedClock(NOW);
    const bank = paced(clock);
    t = await createTestApp({}, { clock, transports: { monobank: bank.transport } });
    const client = new Client(t);
    await client.start();
    const response = await client.post('/api/connection', { mode: 'token', token: 'x'.repeat(44) });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'validation_failed',
      errors: [{ path: 'token' }],
    });
    expect((await client.get('/api/session')).json().connections).toEqual([]);
  });
});
