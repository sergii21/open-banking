import { afterEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/clock';
import { DiagnosticsCollector } from '../src/domain/diagnostics';
import { AppError } from '../src/errors';
import { InspectorStore } from '../src/modules/inspector/inspector-store';
import { EventBus } from '../src/modules/events/event-bus';
import { MonobankProvider, normaliseToken } from '../src/providers/monobank/adapter';
import { TokenRejectedError } from '../src/providers/port';
import { ProviderHttp, type Transport } from '../src/providers/transport';
import { NOW, calendar } from './helpers';

const CTX = { sessionId: 'ses_test', connectionId: null };
const TOKEN = { accessToken: 'uA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v' };

/** What monobank's published spec describes, with the awkward cases a real customer has. */
const CLIENT_INFO = {
  clientId: '3MSaMMtczs',
  name: 'Іван Петренко',
  webHookUrl: '',
  permissions: 'psfj',
  accounts: [
    {
      id: 'acc-white-usd',
      sendId: 'aaa',
      balance: 128430,
      creditLimit: 0,
      type: 'white',
      currencyCode: 840,
      cashbackType: 'None',
      maskedPan: ['537541******0393'],
      iban: 'UA663220010000026203456789012',
    },
    {
      id: 'acc-platinum',
      sendId: 'bbb',
      balance: 3765945,
      creditLimit: 5000000,
      type: 'platinum',
      currencyCode: 980,
      cashbackType: 'Miles',
      maskedPan: ['444111******7719'],
      iban: 'UA583220010000026207654321098',
    },
    {
      id: 'acc-black',
      sendId: 'ccc',
      balance: 6425018,
      creditLimit: 0,
      type: 'black',
      currencyCode: 980,
      cashbackType: 'UAH',
      maskedPan: ['537541******4242', '537541******1111'],
      iban: 'UA213220010000026201234567890',
    },
    {
      id: 'acc-strange',
      balance: 100,
      currencyCode: 826,
      type: 'brand-new-type',
      somethingNew: { a: 1 },
    },
    { id: 'acc-broken', balance: 'lots', currencyCode: 980 },
  ],
  jars: [
    {
      id: 'jar-trip',
      sendId: 'ddd',
      title: 'На відпустку',
      description: 'Греція',
      currencyCode: 980,
      balance: 5430000,
      goal: 12000000,
    },
    { id: 'jar-plain', title: null, currencyCode: 980, balance: '250000' },
  ],
};

const STATEMENT = [
  {
    id: 'hold-1',
    time: 1793700000,
    description: 'Сільпо',
    mcc: 5411,
    originalMcc: 5411,
    hold: true,
    amount: -31240,
    operationAmount: -31240,
    currencyCode: 980,
    commissionRate: 0,
    cashbackAmount: 312,
    balance: 6393778,
  },
  {
    id: 'fx-1',
    time: 1793690000,
    description: 'Amazon.com',
    mcc: 5942,
    hold: false,
    amount: -142380,
    operationAmount: -3499,
    currencyCode: 980,
    commissionRate: 0,
    cashbackAmount: 0,
    balance: 6425018,
  },
  {
    id: 'p2p-in',
    time: 1793680000,
    description: 'Від: Олена К.',
    mcc: 4829,
    hold: false,
    amount: 80000,
    currencyCode: 980,
    balance: 6567398,
    comment: 'За квитки\nдякую',
    receiptId: 'AB12-CD34-EF56-GH78',
  },
  {
    id: 'unknown-ccy',
    time: 1793670000,
    description: 'Weird',
    amount: -100,
    currencyCode: 999,
    balance: 6487398,
  },
  {
    id: 'string-numbers',
    time: '1793660000',
    description: ' Фора ',
    mcc: '5411',
    amount: '-5000',
    currencyCode: 980,
    balance: 6487498,
  },
  { id: 'dup', time: 1793650000, description: 'First copy', amount: -100, currencyCode: 980 },
  { id: 'dup', time: 1793650000, description: 'Second copy', amount: -100, currencyCode: 980 },
  { description: 'no id at all', time: 1793640000, amount: -100, currencyCode: 980 },
  { id: 'no-amount', time: 1793630000, description: 'x', currencyCode: 980 },
  'not even an object',
];

type Reply = { status: number; body: unknown; headers?: Record<string, string> };

function adapter(replies: Record<string, Reply>) {
  const calls: { url: string; headers: Headers }[] = [];
  const transport: Transport = (url, init) => {
    calls.push({ url, headers: new Headers(init.headers) });
    const path = new URL(url).pathname;
    const key = Object.keys(replies).find((k) => path.startsWith(k));
    const reply = key ? replies[key] : { status: 404, body: {} };
    return Promise.resolve(
      new Response(JSON.stringify(reply?.body), {
        status: reply?.status ?? 404,
        headers: { 'content-type': 'application/json', ...reply?.headers },
      }),
    );
  };
  const clock = fixedClock(NOW);
  const diagnostics = new DiagnosticsCollector();
  const provider = new MonobankProvider({
    id: 'monobank',
    mode: 'live',
    label: 'monobank',
    http: new ProviderHttp({
      provider: 'monobank',
      mode: 'live',
      transport,
      inspector: new InspectorStore(new EventBus()),
      clock,
    }),
    apiUrl: 'https://api.monobank.test',
    limits: {
      statementIntervalMs: 61_000,
      infoIntervalMs: 61_000,
      maxWindowDays: 31,
      maxItemsPerCall: 500,
      historyMonths: 2,
    },
    calendar,
    clock,
    diagnostics,
  });
  return { provider, calls, diagnostics };
}

let failure: unknown;
const caught = async (run: () => Promise<unknown>): Promise<unknown> => {
  failure = undefined;
  try {
    await run();
  } catch (error) {
    failure = error;
  }
  return failure;
};
afterEach(() => {
  failure = undefined;
});

describe('monobank accounts', () => {
  it('maps cards, a credit card and jars, orders the main card first, and keeps what it cannot read out', async () => {
    const { provider, diagnostics } = adapter({
      '/personal/client-info': { status: 200, body: CLIENT_INFO },
    });
    const accounts = await provider.fetchAccounts(TOKEN, CTX);

    expect(accounts.map((a) => a.providerAccountId)).toEqual([
      'acc-black', // the hryvnia cards come first, the black one before the platinum
      'acc-platinum',
      'acc-white-usd', // then the foreign-currency cards
      'acc-strange',
      'jar-trip',
      'jar-plain', // numeric strings are read, a missing title gets a name
    ]);
    const black = accounts[0];
    expect(black).toMatchObject({
      kind: 'card',
      name: 'Black',
      currency: 'UAH',
      last4: '4242',
      creditLimitMinor: 0,
      balanceMinor: 6425018,
    });
    const credit = accounts[1];
    expect(credit).toMatchObject({
      name: 'Platinum',
      creditLimitMinor: 5000000,
      balanceMinor: 3765945,
    });
    expect(accounts[2]).toMatchObject({ name: 'White USD', currency: 'USD', last4: '0393' });
    expect(accounts[4]).toMatchObject({
      kind: 'jar',
      name: 'На відпустку',
      goalMinor: 12000000,
      last4: null,
    });
    expect(accounts[5]).toMatchObject({
      kind: 'jar',
      name: 'Jar',
      balanceMinor: 250000,
      goalMinor: null,
    });
    // The one account with an unknown type and an unknown currency is still shown.
    expect(accounts[3]).toMatchObject({ name: 'brand-new-type GBP', currency: 'GBP' });

    const snapshot = diagnostics.snapshot();
    expect(snapshot.warnings.map((w) => w.message).join('\n')).toMatch(/skipped an account or jar/);
    expect(snapshot.shapes.find((s) => s.path === 'client-info.accounts')?.unknown).toEqual([
      'somethingNew',
    ]);
  });

  it('sends the token as X-Token and nothing else about the person', async () => {
    const { provider, calls } = adapter({
      '/personal/client-info': { status: 200, body: CLIENT_INFO },
    });
    await provider.fetchAccounts(TOKEN, CTX);
    expect(calls[0]?.headers.get('x-token')).toBe(TOKEN.accessToken);
    expect(calls[0]?.url).toBe('https://api.monobank.test/personal/client-info');
  });
});

describe('monobank statements', () => {
  it('reads holds, foreign-currency purchases, transfers with comments and balances, newest first', async () => {
    const { provider, calls } = adapter({
      '/personal/statement': { status: 200, body: STATEMENT },
    });
    const rows = await provider.fetchTransactions(
      TOKEN,
      { providerAccountId: 'acc-black', currency: 'UAH' },
      { from: '2026-10-04', to: '2026-11-03' },
      CTX,
    );

    expect(rows.map((r) => r.providerTxnId)).toEqual([
      'hold-1',
      'fx-1',
      'p2p-in',
      'unknown-ccy',
      'string-numbers',
      'dup',
    ]);
    expect(rows[0]).toMatchObject({
      status: 'pending',
      amountMinor: -31240,
      cashbackMinor: 312,
      balanceAfterMinor: 6393778,
      mcc: 5411,
    });
    // The UAH amount is what the account was charged; the dollars are not named by the bank, so they are not shown.
    expect(rows[1]).toMatchObject({ status: 'booked', amountMinor: -142380, currency: 'UAH' });
    expect(rows[2]).toMatchObject({
      amountMinor: 80000,
      comment: 'За квитки дякую',
      receiptId: 'AB12-CD34-EF56-GH78',
      mcc: 4829,
    });
    expect(rows[3]?.currency).toBe('#999');
    expect(rows[4]).toMatchObject({
      description: 'Фора',
      amountMinor: -5000,
      mcc: 5411,
      ts: 1793660000000,
    });
    expect(rows[5]?.description).toBe('First copy');

    const url = new URL(calls[0]?.url ?? '');
    const [, , , account, from, to] = url.pathname.split('/');
    expect(account).toBe('acc-black');
    // Kyiv days, not UTC days; and never more than the 31 days and one hour the bank allows.
    expect(Number(to) - Number(from)).toBeLessThanOrEqual(2_682_000);
    expect(Number(from)).toBe(Math.floor(calendar.dayStart('2026-10-04') / 1000));
  });

  it('counts what it skipped without saying what it was', async () => {
    const { provider, diagnostics } = adapter({
      '/personal/statement': { status: 200, body: STATEMENT },
    });
    await provider.fetchTransactions(
      TOKEN,
      { providerAccountId: 'x', currency: 'UAH' },
      { from: '2026-10-04', to: '2026-11-03' },
      CTX,
    );
    const text = JSON.stringify(diagnostics.snapshot());
    expect(text).toContain('skipped a row');
    expect(text).not.toContain('no id at all');
    expect(text).not.toContain('Сільпо');
    expect(text).not.toContain('Amazon');
  });

  it('turns the bank’s answers into the states the screens know', async () => {
    const run = async (status: number, headers?: Record<string, string>) => {
      const { provider } = adapter({
        '/personal/statement': {
          status,
          body: { errorDescription: 'x' },
          ...(headers ? { headers } : {}),
        },
      });
      return caught(() =>
        provider.fetchTransactions(
          TOKEN,
          { providerAccountId: 'x', currency: 'UAH' },
          { from: '2026-10-04', to: '2026-11-03' },
          CTX,
        ),
      );
    };
    expect(await run(403)).toBeInstanceOf(TokenRejectedError);
    const limited = await run(429);
    expect(limited).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 60 });
    expect(await run(429, { 'retry-after': '17' })).toMatchObject({ retryAfterSeconds: 17 });
    expect(await run(503)).toMatchObject({ code: 'bank_unavailable' });
    expect(await run(400)).toMatchObject({ code: 'provider_error' });
  });

  it('refuses an answer that is not a list instead of guessing', async () => {
    const { provider } = adapter({ '/personal/statement': { status: 200, body: { oops: true } } });
    const error = await caught(() =>
      provider.fetchTransactions(
        TOKEN,
        { providerAccountId: 'x', currency: 'UAH' },
        { from: '2026-10-04', to: '2026-11-03' },
        CTX,
      ),
    );
    expect(error).toMatchObject({ code: 'provider_error' });
  });
});

describe('connecting', () => {
  it('cleans a pasted token, rejects a wrong one with words, and does not call the bank for rubbish', async () => {
    expect(normaliseToken('  "uA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v"\n')).toBe(
      TOKEN.accessToken,
    );

    const { provider, calls } = adapter({
      '/personal/client-info': { status: 403, body: { errorDescription: "Unknown 'X-Token'" } },
    });
    const rubbish = await caught(() => provider.connect({ token: 'short' }, CTX));
    expect(rubbish).toBeInstanceOf(AppError);
    expect(calls).toHaveLength(0);

    const wrong = await caught(() => provider.connect({ token: TOKEN.accessToken }, CTX));
    expect(wrong).toMatchObject({ code: 'validation_failed', errors: [{ path: 'token' }] });
    expect(calls).toHaveLength(1);
  });
});

describe('rates', () => {
  it('reads buy, sell and cross rates and skips currencies it does not know', async () => {
    const { provider } = adapter({
      '/bank/currency': {
        status: 200,
        body: [
          {
            currencyCodeA: 840,
            currencyCodeB: 980,
            date: 1793690000,
            rateBuy: 41.15,
            rateSell: 41.6,
          },
          { currencyCodeA: 826, currencyCodeB: 980, date: 1793690000, rateCross: 55.2 },
          { currencyCodeA: 12345, currencyCodeB: 980, date: 1793690000, rateCross: 1 },
          { currencyCodeA: 'x' },
        ],
      },
    });
    const pairs = await provider.fetchRates(CTX);
    expect(pairs).toEqual([
      { a: 'USD', b: 'UAH', buy: 41.15, sell: 41.6, cross: null, date: 1793690000 },
      { a: 'GBP', b: 'UAH', buy: null, sell: null, cross: 55.2, date: 1793690000 },
    ]);
  });
});
