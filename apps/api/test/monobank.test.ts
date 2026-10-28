import { afterEach, describe, expect, it } from 'vitest';
import {
  AccountList,
  ConnectionList,
  InspectorCallList,
  TransactionPage,
} from '@ledger-lens/contracts';
import { fixedClock } from '../src/clock';
import { categorise } from '../src/domain/categoriser';
import { planWindows } from '../src/domain/sync-plan';
import { EventBus } from '../src/modules/events/event-bus';
import { InspectorStore } from '../src/modules/inspector/inspector-store';
import { TokenRejectedError, type CallContext } from '../src/providers/port';
import { MonobankProvider } from '../src/providers/monobank/adapter';
import { ProviderHttp } from '../src/providers/transport';
import { createTestApp, newClient, type Client, type TestApp } from './helpers';
import { MONO_CARD, MONO_TOKEN, MonobankStub } from './monobank-stub';

const CTX: CallContext = { sessionId: 'ses_test', connectionId: 'con_test' };
const API = 'https://api.monobank.ua';
const TOKENS = {
  accessToken: MONO_TOKEN,
  refreshToken: null,
  expiresAt: '2036-10-28T10:00:00.000Z',
  scope: null,
};

function adapter(stub = new MonobankStub()) {
  const clock = fixedClock('2026-10-28T10:00:00.000Z');
  stub.useClock(clock);
  const inspector = new InspectorStore(new EventBus());
  const provider = new MonobankProvider({
    http: new ProviderHttp({
      provider: 'monobank',
      mode: 'live',
      transport: stub.transport,
      inspector,
      clock,
    }),
    config: { historyMonths: 3, apiUrl: API, minIntervalSeconds: 61 },
    clock,
  });
  return { provider, stub, clock, inspector };
}

describe('monobank adapter: accounts', () => {
  it('lists cards and jars with exact minor units, own funds below the credit limit and masked identifiers', async () => {
    const { provider } = adapter();
    const accounts = await provider.fetchAccounts(TOKENS, CTX);

    expect(accounts.map((a) => [a.name, a.type, a.currency])).toEqual([
      ['Black card', 'current', 'UAH'],
      ['Platinum card', 'current', 'UAH'],
      ['Black card USD', 'current', 'USD'],
      ['На відпустку', 'savings', 'UAH'],
    ]);
    const [black, platinum, usd, jar] = accounts;
    expect(black.balance.amountMinor).toBe(1_050_000);
    // `balance` counts the credit limit: 25,000.00 available with a 30,000.00 limit means 5,000.00 of credit is in use.
    expect(platinum.balance.amountMinor).toBe(-500_000);
    expect(platinum.availableBalance?.amountMinor).toBe(2_500_000);
    expect(usd.balance).toEqual({ amountMinor: 120_050, currency: 'USD' });
    expect(jar.balance.amountMinor).toBe(4_500_000);
    expect(black.maskedIdentifier).not.toContain('26201234567890');
    expect(black.maskedIdentifier).toMatch(/7890$/);
    expect(jar.maskedIdentifier).toBeNull();
  });

  it('answers a second read inside the same minute from memory, because the bank allows one per minute', async () => {
    const { provider, stub, clock } = adapter();
    await provider.fetchAccounts(TOKENS, CTX);
    await provider.fetchBalance(TOKENS, { providerAccountId: MONO_CARD, currency: 'UAH' }, CTX);
    expect(stub.count('client-info')).toBe(1);

    clock.advance(61_000);
    await provider.fetchAccounts(TOKENS, CTX);
    expect(stub.count('client-info')).toBe(2);
  });
});

describe('monobank adapter: transactions', () => {
  const window = { from: '2026-09-28', to: '2026-10-28' };

  it('maps statement rows: signs, holds as pending, merchant category codes, notes and transfer counterparties', async () => {
    const { provider } = adapter();
    const rows = await provider.fetchTransactions(
      TOKENS,
      { providerAccountId: MONO_CARD, currency: 'UAH' },
      window,
      CTX,
    );
    expect(rows).toHaveLength(8);
    const byId = Object.fromEntries(rows.map((r) => [r.providerTxnId, r]));

    expect(byId['silpo-0001']).toMatchObject({
      status: 'booked',
      amount: { amountMinor: -45_620, currency: 'UAH' },
      description: 'Сільпо',
      counterparty: null,
      providerCategory: 'MCC:5411',
      bookedAt: '2026-10-27T18:40:00.000Z',
    });
    expect(byId['hold-uklon-001']).toMatchObject({
      status: 'pending',
      providerCategory: 'MCC:4121',
    });
    expect(byId['p2p-in-0001']?.description).toBe('Від: Іван І. – За обід');
    expect(byId['salary-0001']).toMatchObject({
      counterparty: 'ТОВ РОМАШКА',
      amount: { amountMinor: 4_500_000 },
    });
    // No description at all: the user's own note is what remains, and a row with neither is still a row.
    expect(byId['note-only-0001']).toMatchObject({ description: 'Обмін', providerCategory: null });
  });

  it('asks for the window in Unix seconds, never past now, and never longer than the bank allows', async () => {
    const { provider, stub } = adapter();
    await provider.fetchTransactions(
      TOKENS,
      { providerAccountId: MONO_CARD, currency: 'UAH' },
      window,
      CTX,
    );
    const url = stub.statements()[0].url;
    const [, , , , from, to] = url.pathname.split('/');
    expect(Number(from)).toBe(Date.parse('2026-09-28T00:00:00Z') / 1000);
    expect(Number(to)).toBe(Date.parse('2026-10-28T10:00:00Z') / 1000); // "now", not the end of today
    expect(Number(to) - Number(from)).toBeLessThanOrEqual(2_682_000);
  });
});

describe('monobank adapter: failures', () => {
  const read = async (
    stub: MonobankStub,
    status: number,
    body: unknown,
    headers?: Record<string, string>,
  ) => {
    const { provider } = adapter(stub);
    stub.once('GET api.monobank.ua/personal/client-info', status, body, headers);
    return provider.fetchAccounts(TOKENS, CTX);
  };

  it('403 with the real error body means the token is no longer accepted', async () => {
    const { provider, stub } = adapter();
    stub.validToken = 'something-else';
    await expect(provider.fetchAccounts(TOKENS, CTX)).rejects.toBeInstanceOf(TokenRejectedError);
  });

  it('429 is a rate limit with a minute to wait, 5xx is an outage, junk is a provider error', async () => {
    await expect(
      read(new MonobankStub(), 429, { errorDescription: 'Too many requests' }),
    ).rejects.toMatchObject({
      code: 'rate_limited',
      retryAfterSeconds: 60,
    });
    await expect(read(new MonobankStub(), 503, {})).rejects.toMatchObject({
      code: 'bank_unavailable',
    });
    await expect(read(new MonobankStub(), 200, { accounts: 'nope' })).rejects.toMatchObject({
      code: 'provider_error',
      status: 502,
    });
  });

  it('rejects a mistyped token when connecting, pointing at the field', async () => {
    const { provider } = adapter();
    await expect(
      provider.connectWithToken({ token: 'not-a-real-token' }, CTX),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      errors: [{ path: 'token' }],
    });
  });

  it('keeps the token out of the Inspector and masks account identifiers, since this is a live bank', async () => {
    const { provider, inspector } = adapter();
    await provider.fetchAccounts(TOKENS, CTX);
    const call = inspector.list(CTX.sessionId)[0];
    expect(call.request.headers['x-token']).toBe('[redacted]');
    const text = JSON.stringify(call);
    expect(text).not.toContain(MONO_TOKEN);
    expect(text).not.toContain('UA733220010000026201234567890');
    expect(text).not.toContain('537541******1234');
  });
});

// ============================================================================================== through the BFF

let t: TestApp;
let stub: MonobankStub;

async function appWithMonobank(historyMonths = 3): Promise<Client> {
  stub = new MonobankStub();
  t = await createTestApp(
    {
      providers: {
        mock: { enabled: true },
        truelayer: null,
        monobank: { historyMonths, apiUrl: API, minIntervalSeconds: 61 },
      },
    },
    undefined,
    { monobank: stub.transport },
  );
  stub.useClock(t.clock);
  return newClient(t);
}

const connect = (client: Client, token = MONO_TOKEN, extra: object = {}) =>
  client.post('/api/connections/token', { institutionId: 'monobank:monobank', token, ...extra });

/** Runs background steps, one per minute, until the queue is empty. */
async function drain(maxSteps = 40): Promise<number> {
  let steps = 0;
  while (steps < maxSteps && t.ctx.repos.syncJobs.connectionsWithPending().length > 0) {
    if ((await t.ctx.sync.runDue()) > 0) steps += 1;
    t.clock.advance(61_000);
  }
  return steps;
}

describe('monobank through the BFF', () => {
  afterEach(async () => {
    await t.close();
  });

  it('connects with one bank read, lists cards and jars, and queues the history instead of blocking on it', async () => {
    const client = await appWithMonobank();
    const response = await connect(client);
    expect(response.statusCode).toBe(201);

    expect(stub.count('client-info')).toBe(1); // the check and the first sync share one request
    expect(stub.statements()).toHaveLength(0);

    const connection = ConnectionList.parse((await client.get('/api/connections')).json()).items[0];
    expect(connection).toMatchObject({
      provider: 'monobank',
      mode: 'live',
      status: 'active',
      consentExpiresAt: null,
      consentState: 'none',
      permissions: ['accounts', 'balances', 'transactions'],
      accountCount: 4,
      sync: { done: 0, total: 12 }, // 3 monthly windows x 4 accounts
    });
    expect(AccountList.parse((await client.get('/api/accounts')).json()).items).toHaveLength(4);
    expect(TransactionPage.parse((await client.get('/api/transactions')).json()).total).toBe(0);
  });

  it('loads history one request a minute, newest window of every account first, and never faster than the bank allows', async () => {
    const client = await appWithMonobank();
    await connect(client);

    expect(await t.ctx.sync.runDue()).toBe(1);
    expect(await t.ctx.sync.runDue()).toBe(0); // the gate is shut for a minute
    t.clock.advance(30_000);
    expect(await t.ctx.sync.runDue()).toBe(0);
    t.clock.advance(31_000);
    expect(await t.ctx.sync.runDue()).toBe(1);
    expect(
      ConnectionList.parse((await client.get('/api/connections')).json()).items[0]?.sync,
    ).toEqual({
      done: 2,
      total: 12,
    });

    await drain();
    const statements = stub.statements();
    expect(statements).toHaveLength(12);
    // The stub answers 429 if we ever go faster; that none did is what the gap proves.
    for (let i = 1; i < statements.length; i += 1) {
      expect(statements[i].at - statements[i - 1].at).toBeGreaterThanOrEqual(60_000);
    }
    // Round-robin: window 1 for all four accounts, then window 2 for all four, then window 3.
    const ids = statements.map((s) => s.url.pathname.split('/')[3]);
    expect(new Set(ids.slice(0, 4)).size).toBe(4);
    expect(ids.slice(0, 4)).toEqual(ids.slice(4, 8));

    expect(
      ConnectionList.parse((await client.get('/api/connections')).json()).items[0]?.sync,
    ).toBeNull();
    const page = TransactionPage.parse((await client.get('/api/transactions?limit=50')).json());
    expect(page.total).toBe(8);
    expect(page.items.filter((i) => i.status === 'pending')).toHaveLength(1);
  });

  it('categorises from merchant category codes and Ukrainian descriptions', async () => {
    const client = await appWithMonobank();
    await connect(client);
    await drain();
    const page = TransactionPage.parse((await client.get('/api/transactions?limit=50')).json());
    const category = (text: string) =>
      page.items.find((i) => i.description.startsWith(text))?.category;

    expect(category('Сільпо')).toBe('groceries');
    expect(category('Uklon')).toBe('transport');
    expect(category('Зарплата')).toBe('income');
    expect(category('Від: Іван')).toBe('transfers');
    expect(category('Netflix')).toBe('subscriptions');
    expect(category('Банкомат')).toBe('other');
    expect(category('Переказ на банку')).toBe('transfers');
  });

  it('waits out a 429 from the bank instead of hammering it, then retries the same step', async () => {
    const client = await appWithMonobank();
    await connect(client);
    stub.once('GET api.monobank.ua/personal/statement', 429, {
      errorDescription: 'Too many requests',
    });

    expect(await t.ctx.sync.runDue()).toBe(0);
    t.clock.advance(30_000);
    expect(await t.ctx.sync.runDue()).toBe(0);
    t.clock.advance(31_000);
    expect(await t.ctx.sync.runDue()).toBe(1);
    expect(
      ConnectionList.parse((await client.get('/api/connections')).json()).items[0]?.sync?.done,
    ).toBe(1);
  });

  it('asks for the rest of a window when the bank returned a full page of 500', async () => {
    const client = await appWithMonobank();
    await connect(client);
    const hour = 3600;
    const now = Math.floor(t.clock.now().getTime() / 1000);
    stub.statementRows = Array.from({ length: 600 }, (_, i) => ({
      id: `bulk-${i}`,
      time: now - i * hour,
      description: `Row ${i}`,
      amount: -100,
      currencyCode: 980,
    }));

    expect(await t.ctx.sync.runDue()).toBe(1);
    expect(
      ConnectionList.parse((await client.get('/api/connections')).json()).items[0]?.sync?.total,
    ).toBe(13);
    await drain();
    expect(
      TransactionPage.parse((await client.get('/api/transactions?limit=1')).json()).total,
    ).toBe(600);
  });

  it('refuses a Refresh while a bank read is in its rate window, then allows it', async () => {
    const client = await appWithMonobank();
    await connect(client);
    t.clock.advance(61_000);
    await t.ctx.sync.runDue();

    const account = AccountList.parse((await client.get('/api/accounts')).json()).items[0];
    t.clock.advance(25_000); // past the refresh cool-down, still inside the bank's minute
    const early = await client.post(`/api/accounts/${account.id}/refresh`);
    expect(early.statusCode).toBe(429);
    expect(early.json()).toMatchObject({ code: 'rate_limited' });
    expect(early.json<{ retryAfterSeconds: number }>().retryAfterSeconds).toBeGreaterThan(30);

    t.clock.advance(40_000);
    const ok = await client.post(`/api/accounts/${account.id}/refresh`);
    expect(ok.statusCode).toBe(200);
  });

  it('rejects a token the bank does not recognise without creating a connection', async () => {
    const client = await appWithMonobank();
    const response = await connect(client, 'a-token-monobank-has-never-seen');
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'validation_failed',
      errors: [{ path: 'token' }],
    });
    expect(ConnectionList.parse((await client.get('/api/connections')).json()).items).toHaveLength(
      0,
    );
    expect(response.body).not.toContain('a-token-monobank-has-never-seen');
  });

  it('when monobank stops accepting the token the connection needs a new one, the queue stops, and reconnecting fixes it', async () => {
    const client = await appWithMonobank();
    const { connectionId } = (await connect(client)).json<{ connectionId: string }>();

    stub.validToken = 'revoked-and-reissued';
    t.clock.advance(61_000);
    await t.ctx.sync.runDue();
    const lost = ConnectionList.parse((await client.get('/api/connections')).json()).items[0];
    expect(lost).toMatchObject({ status: 'needs_reauth', sync: null });

    t.clock.advance(61_000);
    const again = await connect(client, 'revoked-and-reissued', {
      reconnectConnectionId: connectionId,
    });
    expect(again.statusCode).toBe(201);
    expect(again.json()).toEqual({ connectionId });
    const found = ConnectionList.parse((await client.get('/api/connections')).json()).items;
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      id: connectionId,
      status: 'active',
      sync: { done: 0, total: 12 },
    });
  });

  it('never lets the token reach the browser, the Inspector or the database in the clear', async () => {
    const client = await appWithMonobank();
    await connect(client);
    await drain(4);
    for (const url of [
      '/api/connections',
      '/api/accounts',
      '/api/transactions',
      '/api/inspector/calls',
    ]) {
      expect((await client.get(url)).body).not.toContain(MONO_TOKEN);
    }
    const calls = InspectorCallList.parse((await client.get('/api/inspector/calls')).json()).items;
    expect(calls.find((c) => c.label === 'Get client info')?.request.headers['x-token']).toBe(
      '[redacted]',
    );
    const stored = t.db.get<{ tokens_enc: string }>('SELECT tokens_enc FROM connections');
    expect(stored?.tokens_enc).toBeTruthy();
    expect(stored?.tokens_enc).not.toContain(MONO_TOKEN);
  });
});

describe('planWindows', () => {
  it('covers the months up to today in contiguous windows of at most the allowed length, newest first', () => {
    const windows = planWindows('2026-10-28', 3, 31);
    expect(windows).toEqual([
      { from: '2026-09-28', to: '2026-10-28' },
      { from: '2026-08-28', to: '2026-09-27' },
      { from: '2026-07-28', to: '2026-08-27' },
    ]);
  });

  it('never leaves a gap or overlap, whatever the month lengths', () => {
    for (const today of ['2026-03-31', '2028-02-29', '2026-01-01', '2026-12-31']) {
      const windows = planWindows(today, 13, 31);
      expect(windows[0].to).toBe(today);
      for (const [i, window] of windows.entries()) {
        const days = (Date.parse(window.to) - Date.parse(window.from)) / 86_400_000 + 1;
        expect(days).toBeLessThanOrEqual(31);
        const next = windows[i + 1];
        if (next) expect((Date.parse(window.from) - Date.parse(next.to)) / 86_400_000).toBe(1);
      }
    }
  });
});

describe('categoriser: merchant category codes and Ukrainian text', () => {
  const cat = (description: string, amountMinor: number, providerCategory: string | null = null) =>
    categorise({ description, counterparty: null, amountMinor, providerCategory });

  it('trusts an MCC over keywords it has never seen', () => {
    expect(cat('Невідомий магазин', -10_000, 'MCC:5411')).toBe('groceries');
    expect(cat('Wolt', -10_000, 'MCC:5812')).toBe('dining');
    expect(cat('Укрзалізниця', -10_000, 'MCC:4112')).toBe('transport');
    expect(cat('Booking', -10_000, 'MCC:7011')).toBe('travel');
  });

  it('reads Cyrillic with real word boundaries (й and ї fold like the text does)', () => {
    expect(cat('Аптека Подорожник', -1000)).toBe('health');
    expect(cat('Київстар поповнення', -1000)).toBe('bills');
    expect(cat('АТБ-маркет', -1000)).toBe('groceries');
    expect(cat('Переказ на свою картку', -1000)).toBe('transfers');
    expect(cat('Зарплата за жовтень', 5_000_000)).toBe('income');
    expect(cat('Ромашка', 100_000)).toBe('income'); // unknown money in
    expect(cat('Ромашка', -100_000)).toBe('other'); // unknown money out
  });
});
