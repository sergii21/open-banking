import { describe, expect, it } from 'vitest';
import { fixedClock } from '../src/clock';
import { DiagnosticsCollector } from '../src/domain/diagnostics';
import { AppError } from '../src/errors';
import { EventBus } from '../src/modules/events/event-bus';
import { InspectorStore } from '../src/modules/inspector/inspector-store';
import { TokenRejectedError } from '../src/providers/port';
import { PrivatBankProvider, ROUTINE_MESSAGE } from '../src/providers/privatbank/adapter';
import { FAKE_PRIVAT_TOKEN, FakeAutoclient } from '../src/providers/privatbank/demo/fake';
import { ProviderHttp, type Transport } from '../src/providers/transport';
import { NOW, calendar, pauseOn, privat } from './helpers';

const CTX = { sessionId: 'ses_test', connectionId: null };
const IBAN_UAH = 'UA213052990000026007233566001';

interface Rig {
  clock: ReturnType<typeof fixedClock>;
  fake: FakeAutoclient;
  inspector: InspectorStore;
  diagnostics: DiagnosticsCollector;
  provider: PrivatBankProvider;
}

function rig(
  options: { transport?: (fake: FakeAutoclient) => Transport; historyDays?: number } = {},
): Rig {
  const clock = fixedClock(NOW);
  const fake = privat(clock, options.historyDays ? { historyDays: options.historyDays } : {});
  const inspector = new InspectorStore(new EventBus());
  const diagnostics = new DiagnosticsCollector();
  const provider = new PrivatBankProvider({
    id: 'privatbank',
    mode: 'live',
    label: 'PrivatBank business',
    http: new ProviderHttp({
      provider: 'privatbank',
      mode: 'live',
      transport: options.transport ? options.transport(fake) : fake.transport,
      inspector,
      clock,
    }),
    apiUrl: 'https://acp.privatbank.test',
    limits: {
      statementIntervalMs: 1000,
      infoIntervalMs: 1000,
      maxWindowDays: 31,
      maxItemsPerCall: Number.MAX_SAFE_INTEGER,
      historyMonths: 2,
      sharedLimit: true,
    },
    calendar,
    clock,
    diagnostics,
    pause: pauseOn(clock),
  });
  return { clock, fake, inspector, diagnostics, provider };
}

const TOKENS = { accessToken: FAKE_PRIVAT_TOKEN };

/** The bank adds the National Bank's "ultimate payer" fields to some items; one with a passport number is put on the first row. */
const withPassport =
  (fake: FakeAutoclient): Transport =>
  async (url, init) => {
    const response = await fake.transport(url, init);
    if (!new URL(url).pathname.endsWith('/transactions')) return response;
    const body = (await response.json()) as { transactions: Record<string, string>[] };
    body.transactions[0] = { ...body.transactions[0], PAYER_ULTMT_DOCUMENT: 'КК123456' };
    return new Response(JSON.stringify(body), { status: 200 });
  };

describe('PrivatBank Autoclient adapter', () => {
  it('checks the key with the server dates, then lists the accounts, never closer than a second apart', async () => {
    const { provider, fake } = rig();
    const { accounts } = await provider.connect({ token: `  ${FAKE_PRIVAT_TOKEN}\n` }, CTX);

    expect(fake.requests.map((r) => r.path)).toEqual([
      '/api/statements/settings',
      '/api/statements/balance/interim',
    ]);
    expect(accounts.map((a) => [a.currency, a.cardType, a.last4])).toEqual([
      ['UAH', 'business', '6001'],
      ['USD', 'business', '6002'],
    ]);
    expect(accounts[0]).toMatchObject({
      kind: 'card',
      name: 'Business account',
      providerAccountId: IBAN_UAH,
      creditLimitMinor: 0,
    });
    expect(accounts[1]?.name).toBe('Business account USD');
    expect(accounts.every((a) => Number.isSafeInteger(a.balanceMinor) && a.balanceMinor > 0)).toBe(
      true,
    );

    const gaps = fake.requests.slice(1).map((r, i) => r.at - (fake.requests[i]?.at ?? 0));
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(1000);
  });

  it('queues callers that arrive together behind each other, so no two requests for one key are closer than the limit', async () => {
    // Real time and a short interval: the race this guards against only exists when callers really wait.
    const clock = { now: () => new Date() };
    const fake = new FakeAutoclient({ clock, calendar, token: FAKE_PRIVAT_TOKEN, intervalMs: 40 });
    const provider = new PrivatBankProvider({
      id: 'privatbank',
      mode: 'live',
      label: 'PrivatBank business',
      http: new ProviderHttp({
        provider: 'privatbank',
        mode: 'live',
        transport: fake.transport,
        inspector: new InspectorStore(new EventBus()),
        clock,
      }),
      apiUrl: 'https://acp.privatbank.test',
      limits: {
        statementIntervalMs: 45,
        infoIntervalMs: 45,
        maxWindowDays: 31,
        maxItemsPerCall: Number.MAX_SAFE_INTEGER,
        historyMonths: 2,
        sharedLimit: true,
      },
      calendar,
      clock,
      diagnostics: new DiagnosticsCollector(),
    });
    const results = await Promise.allSettled([
      provider.fetchAccounts(TOKENS, CTX),
      provider.fetchAccounts(TOKENS, CTX),
      provider.connect({ token: FAKE_PRIVAT_TOKEN }, CTX),
      provider.fetchAccounts(TOKENS, CTX),
    ]);
    expect(results.map((r) => r.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ]);
    const gaps = fake.requests.slice(1).map((r, i) => r.at - (fake.requests[i]?.at ?? 0));
    expect(fake.requests.length).toBe(5);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(40);
  });

  it('sends the headers the document requires: the key, utf8, and who is asking', async () => {
    const { provider, fake } = rig();
    await provider.connect({ token: FAKE_PRIVAT_TOKEN }, CTX);
    for (const request of fake.requests) {
      expect(request.headers['token']).toBe(FAKE_PRIVAT_TOKEN);
      expect(request.headers['content-type']).toBe('application/json;charset=utf8');
      expect(request.headers['user-agent']).toMatch(/LedgerLens/);
    }
  });

  it('reads a window in pages of 100 and follows followId to the end without repeating a row', async () => {
    const { provider, fake } = rig({ historyDays: 400 });
    const rows = await provider.fetchTransactions(
      TOKENS,
      { providerAccountId: IBAN_UAH, currency: 'UAH' },
      { from: '2026-01-01', to: '2026-11-03' },
      CTX,
    );
    const calls = fake.requests.filter((r) => r.path === '/api/statements/transactions');
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[0]?.query).toContain('limit=100');
    expect(calls[0]?.query).toContain('startDate=01-01-2026');
    expect(calls[0]?.query).toContain('endDate=03-11-2026');
    expect(calls[1]?.query).toContain('followId=100_online');
    expect(new Set(rows.map((r) => r.providerTxnId)).size).toBe(rows.length);
    expect(rows.length).toBeGreaterThan(100);
    // Newest first.
    expect(rows.map((r) => r.ts)).toEqual([...rows.map((r) => r.ts)].sort((a, b) => b - a));
  });

  it('maps amounts, signs, time and status: money out is negative, a hold is pending, Kyiv time is respected', async () => {
    const { provider } = rig();
    const rows = await provider.fetchTransactions(
      TOKENS,
      { providerAccountId: IBAN_UAH, currency: 'UAH' },
      { from: '2026-10-01', to: '2026-11-03' },
      CTX,
    );
    const hold = rows.find((r) => r.status === 'pending');
    expect(hold).toMatchObject({
      amountMinor: -129_900,
      currency: 'UAH',
      counterparty: 'ТОВ "ХОСТИНГ ГРУП"',
      description: 'Оплата за хостинг (в обробці)',
      mcc: null,
      balanceAfterMinor: null,
    });
    expect(rows.some((r) => r.status === 'booked' && r.amountMinor > 0)).toBe(true);
    expect(rows.every((r) => Number.isSafeInteger(r.amountMinor))).toBe(true);

    // "03.11.2026 hh:mm:00" is Kyiv time (UTC+2 in November), and the day it belongs to is the Kyiv day.
    const at = new Date(hold?.ts ?? 0);
    expect(calendar.dayKey(at.getTime())).toBe('2026-11-03');
    const local = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Kyiv',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(at);
    expect(Number(local)).toBeGreaterThanOrEqual(9);
    expect(Number(local)).toBeLessThanOrEqual(17);
    expect(at.getUTCHours()).toBe(Number(local) - 2);
  });

  it('keeps today and the closed days apart in the two statements and merges them without duplicates', async () => {
    const { provider, fake } = rig();
    const rows = await provider.fetchTransactions(
      TOKENS,
      { providerAccountId: IBAN_UAH, currency: 'UAH' },
      { from: '2026-10-25', to: '2026-11-03' },
      CTX,
    );
    expect(fake.requests.map((r) => r.path)).toContain('/api/statements/transactions/interim');
    expect(new Set(rows.map((r) => r.providerTxnId)).size).toBe(rows.length);
  });

  it('asks only for the interval when the window ends in the past', async () => {
    const { provider, fake } = rig();
    await provider.fetchTransactions(
      TOKENS,
      { providerAccountId: IBAN_UAH, currency: 'UAH' },
      { from: '2026-09-01', to: '2026-09-30' },
      CTX,
    );
    expect(fake.requests.map((r) => r.path)).toEqual(['/api/statements/transactions']);
  });

  it('leaves out reversed, rejected and not-real items, says how many in words, and never in values', async () => {
    const { provider, diagnostics } = rig();
    const rows = await provider.fetchTransactions(
      TOKENS,
      { providerAccountId: IBAN_UAH, currency: 'UAH' },
      { from: '2026-10-25', to: '2026-11-03' },
      CTX,
    );
    expect(rows.some((r) => /Сторнована|Забракований|Інформаційна/.test(r.description))).toBe(
      false,
    );
    const warnings = diagnostics.snapshot().warnings.map((w) => w.message);
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('reversed'),
        expect.stringContaining('rejected'),
        expect.stringContaining('not-real'),
      ]),
    );
  });

  it('keeps names, purposes, ids and amounts out of the diagnostics', async () => {
    const { provider, diagnostics } = rig({ transport: withPassport });
    await provider.connect({ token: FAKE_PRIVAT_TOKEN }, CTX);
    await provider.fetchTransactions(
      TOKENS,
      { providerAccountId: IBAN_UAH, currency: 'UAH' },
      { from: '2026-10-01', to: '2026-11-03' },
      CTX,
    );
    const text = JSON.stringify(diagnostics.snapshot());
    for (const secret of [
      IBAN_UAH,
      FAKE_PRIVAT_TOKEN,
      'ЗОРЯ',
      'Тестовий',
      'Оплата',
      '3145128800',
      'КК123456',
    ]) {
      expect(text).not.toContain(secret);
    }
    // What it does hold: field names, types, counts.
    expect(text).toContain('AUT_CNTR_NAM');
    expect(text).toContain('PAYER_ULTMT_DOCUMENT');
    expect(text).toContain('string×');
  });

  it('files every call under the session with the key, the IBAN, the tax ids and the passport number hidden', async () => {
    const { provider, inspector } = rig({ transport: withPassport });
    await provider.connect({ token: FAKE_PRIVAT_TOKEN }, CTX);
    await provider.fetchTransactions(
      TOKENS,
      { providerAccountId: IBAN_UAH, currency: 'UAH' },
      { from: '2026-10-01', to: '2026-11-03' },
      CTX,
    );
    const calls = inspector.list('ses_test');
    expect(calls.length).toBeGreaterThan(3);
    const text = JSON.stringify(calls);
    for (const secret of [
      FAKE_PRIVAT_TOKEN,
      IBAN_UAH,
      'КК123456',
      '3145128800',
      '26007233566001',
      'Тестовий',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain('"PAYER_ULTMT_DOCUMENT":"[redacted]"');
    const first = calls.at(-1);
    expect(first?.request.headers['token']).toBe('[redacted]');
    expect(first?.request.headers['content-type']).toBe('application/json;charset=utf8');
    // The account in the address is cut to its last four characters; the purpose of a payment stays readable.
    expect(calls.find((c) => c.url.includes('acc='))?.url).toMatch(/acc=•+6001/);
    expect(text).toContain('Оплата');
  });

  describe('when the bank says no', () => {
    it('turns the real "Bad token format" answer into a message for the token field', async () => {
      const { provider } = rig();
      await expect(provider.connect({ token: 'x'.repeat(44) }, CTX)).rejects.toMatchObject({
        code: 'validation_failed',
        errors: [{ path: 'token' }],
      });
      await expect(provider.connect({ token: 'x' }, CTX)).rejects.toMatchObject({
        code: 'validation_failed',
      });
    });

    it('treats a well-formed key the bank does not know as rejected', async () => {
      const { provider } = rig();
      await expect(provider.connect({ token: 'a'.repeat(40) }, CTX)).rejects.toMatchObject({
        code: 'validation_failed',
      });
      await expect(
        provider.fetchAccounts({ accessToken: 'a'.repeat(40) }, CTX),
      ).rejects.toBeInstanceOf(TokenRejectedError);
    });

    it('says the bank is in its daily routine, at connect and in the middle of a sync', async () => {
      const { provider, fake } = rig();
      fake.routine = true;
      await expect(provider.connect({ token: FAKE_PRIVAT_TOKEN }, CTX)).rejects.toMatchObject({
        code: 'bank_unavailable',
        message: ROUTINE_MESSAGE,
      });

      // It starts after the key was accepted: the statement request fails, and the adapter asks why.
      fake.routine = false;
      await provider.connect({ token: FAKE_PRIVAT_TOKEN }, CTX);
      fake.routine = true;
      await expect(
        provider.fetchTransactions(
          TOKENS,
          { providerAccountId: IBAN_UAH, currency: 'UAH' },
          { from: '2026-10-01', to: '2026-11-03' },
          CTX,
        ),
      ).rejects.toMatchObject({ code: 'bank_unavailable', message: ROUTINE_MESSAGE });
    });

    it('reports an outage as the bank not responding', async () => {
      const { provider, fake } = rig();
      fake.down = true;
      await expect(provider.fetchAccounts(TOKENS, CTX)).rejects.toMatchObject({
        code: 'bank_unavailable',
      });
    });

    it('waits when the bank answers 429, for as long as it says', async () => {
      const { provider, fake } = rig();
      // Two requests inside the second, with the adapter's own pacing out of the way.
      const quick = new PrivatBankProvider({
        id: 'privatbank',
        mode: 'live',
        label: 'x',
        http: new ProviderHttp({
          provider: 'privatbank',
          mode: 'live',
          transport: fake.transport,
          inspector: new InspectorStore(new EventBus()),
          clock: fixedClock(NOW),
        }),
        apiUrl: 'https://acp.privatbank.test',
        limits: {
          statementIntervalMs: 0,
          infoIntervalMs: 0,
          maxWindowDays: 31,
          maxItemsPerCall: Number.MAX_SAFE_INTEGER,
          historyMonths: 2,
        },
        calendar,
        clock: fixedClock(NOW),
        diagnostics: new DiagnosticsCollector(),
      });
      await provider.fetchAccounts(TOKENS, CTX);
      const error = await quick.fetchAccounts(TOKENS, CTX).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 1 });
    });

    it('explains an answer it cannot read, and a group key, without inventing a cause', async () => {
      const html = rig({
        transport: () => () =>
          Promise.resolve(new Response('<html>maintenance</html>', { status: 200 })),
      });
      await expect(html.provider.fetchAccounts(TOKENS, CTX)).rejects.toMatchObject({
        code: 'provider_error',
      });
      expect(html.diagnostics.snapshot().warnings[0]?.message).toMatch(/not the JSON shape/);

      const group = rig({
        transport: () => () =>
          Promise.resolve(
            new Response(
              JSON.stringify({
                status: 'ERROR',
                code: 'VE099',
                message: 'Укажіть ID клієнта групи',
              }),
              {
                status: 400,
              },
            ),
          ),
      });
      await expect(group.provider.fetchAccounts(TOKENS, CTX)).rejects.toMatchObject({
        code: 'provider_error',
        message: expect.stringContaining('group'),
      });

      const other = rig({
        transport: () => () =>
          Promise.resolve(
            new Response(
              JSON.stringify({ status: 'ERROR', code: 'VE123', message: 'something else' }),
              {
                status: 400,
              },
            ),
          ),
      });
      await expect(other.provider.fetchAccounts(TOKENS, CTX)).rejects.toMatchObject({
        message: expect.stringContaining('VE123'),
      });
    });
  });

  it('skips a row it cannot read and keeps the others', async () => {
    const { provider, diagnostics } = rig({
      transport: (fake) => async (url, init) => {
        const response = await fake.transport(url, init);
        if (!new URL(url).pathname.endsWith('/transactions')) return response;
        const body = (await response.json()) as { transactions: Record<string, string>[] };
        body.transactions[0] = { ...body.transactions[0], SUM: 'не число' };
        return new Response(JSON.stringify(body), { status: 200 });
      },
    });
    const rows = await provider.fetchTransactions(
      TOKENS,
      { providerAccountId: IBAN_UAH, currency: 'UAH' },
      { from: '2026-09-01', to: '2026-09-30' },
      CTX,
    );
    expect(rows.length).toBeGreaterThan(5);
    expect(
      diagnostics
        .snapshot()
        .warnings.map((w) => w.message)
        .join(),
    ).toMatch(/SUM: not a number/);
  });
});
