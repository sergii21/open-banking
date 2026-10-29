import { AccountList, InsightsSummary, Transaction, TransactionPage } from '@ledger-lens/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, newClient, type Client, type TestApp } from './helpers';

let t: TestApp;
afterEach(async () => {
  await t.close();
});

async function connected(): Promise<{ client: Client; accountId: string }> {
  t = await createTestApp();
  const client = await newClient(t);
  await client.connectBank();
  const accounts = AccountList.parse((await client.get('/api/accounts')).json()).items;
  const current = accounts.find((account) => account.type === 'current');
  if (!current) throw new Error('no current account');
  return { client, accountId: current.id };
}

const page = async (client: Client, query = ''): Promise<TransactionPage> =>
  TransactionPage.parse((await client.get(`/api/transactions?limit=200${query}`)).json());

const summary = async (client: Client, query = ''): Promise<InsightsSummary> => {
  const response = await client.get(`/api/insights/summary${query}`);
  expect(response.statusCode).toBe(200);
  return InsightsSummary.parse(response.json());
};

describe('changing a transaction’s category', () => {
  it('records the customer’s choice, and says it was theirs', async () => {
    const { client } = await connected();
    const groceries = (await page(client, '&category=groceries')).items[0];
    if (!groceries) throw new Error('no groceries transaction');

    const response = await client.request('PATCH', `/api/transactions/${groceries.id}`, {
      payload: { category: 'dining' },
    });
    expect(response.statusCode).toBe(200);
    expect(Transaction.parse(response.json())).toMatchObject({
      id: groceries.id,
      category: 'dining',
      categorySource: 'user',
    });

    const again = (await page(client)).items.find((item) => item.id === groceries.id);
    expect(again).toMatchObject({ category: 'dining', categorySource: 'user' });
  });

  it('is kept when the bank sends the same transaction again', async () => {
    const { client, accountId } = await connected();
    // A booked one: pending rows are replaced, not updated, when the bank reports them again.
    const chosen = (await page(client, '&category=groceries&status=booked')).items[0];
    if (!chosen) throw new Error('no groceries transaction');
    await client.request('PATCH', `/api/transactions/${chosen.id}`, {
      payload: { category: 'health' },
    });

    t.clock.advance(60_000);
    const refreshed = await client.post(`/api/accounts/${accountId}/refresh`);
    expect(refreshed.statusCode).toBe(200);

    const after = (await page(client)).items.find((item) => item.id === chosen.id);
    expect(after).toMatchObject({ category: 'health', categorySource: 'user' });
  });

  it('refuses unknown categories, unknown transactions, and other customers’ transactions', async () => {
    const { client } = await connected();
    const first = (await page(client)).items[0];
    if (!first) throw new Error('no transaction');

    const bad = await client.request('PATCH', `/api/transactions/${first.id}`, {
      payload: { category: 'yachts' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ code: 'validation_failed' });

    const missing = await client.request('PATCH', '/api/transactions/txn_nope', {
      payload: { category: 'other' },
    });
    expect(missing.statusCode).toBe(404);

    const stranger = await newClient(t);
    const theirs = await stranger.request('PATCH', `/api/transactions/${first.id}`, {
      payload: { category: 'other' },
    });
    expect(theirs.statusCode).toBe(404);
    expect((await page(client)).items.find((i) => i.id === first.id)?.category).toBe(
      first.category,
    );
  });

  it('needs the XSRF token like any write', async () => {
    const { client } = await connected();
    const first = (await page(client)).items[0];
    const refused = await client.request('PATCH', `/api/transactions/${first?.id}`, {
      payload: { category: 'other' },
      csrf: false,
    });
    expect(refused.statusCode).toBe(403);
  });
});

describe('the insights summary', () => {
  it('covers six months by default, one block per currency, and recurring payments', async () => {
    const { client } = await connected();
    const result = await summary(client);

    expect(result.from).toBe('2026-05-01');
    expect(result.to).toBe('2026-10-28');
    expect(result.currencies.map((block) => block.currency)).toEqual(['EUR']);
    const eur = result.currencies[0];
    expect(eur?.months.map((m) => m.month)).toEqual([
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
    ]);
    expect(eur?.totalInMinor).toBeGreaterThan(0);
    expect(eur?.totalOutMinor).toBeGreaterThan(0);
    expect(eur?.netMinor).toBe((eur?.totalInMinor ?? 0) - (eur?.totalOutMinor ?? 0));
    // Rent and the subscriptions repeat every month in the demo data.
    const names = result.recurring.map((r) => r.merchant.toLowerCase());
    expect(names.some((n) => n.includes('miete'))).toBe(true);
    expect(names).toContain('netflix');
    expect(
      result.recurring.every((r) => r.cadence === 'monthly' || r.cadence === 'quarterly'),
    ).toBe(true);
  });

  it('agrees with itself: categories, months and the total are the same money, and shares add up', async () => {
    const { client } = await connected();
    const [eur] = (await summary(client)).currencies;
    const byCategory = eur?.categories.reduce((sum, c) => sum + c.spentMinor, 0);
    const byMonth = eur?.months.reduce((sum, m) => sum + m.outMinor, 0);
    expect(byCategory).toBe(eur?.totalOutMinor);
    expect(byMonth).toBe(eur?.totalOutMinor);
    expect(eur?.categories.reduce((sum, c) => sum + c.share, 0)).toBeCloseTo(1, 9);
    expect(eur?.categories.some((c) => c.category === 'income' || c.category === 'transfers')).toBe(
      false,
    );
  });

  it('moves money between categories when the customer recategorises a transaction', async () => {
    const { client } = await connected();
    const before = (await summary(client)).currencies[0];
    const groceries = (
      await page(client, '&category=groceries&status=booked&from=2026-10-01')
    ).items.find((item) => item.amount.amountMinor < 0);
    if (!groceries) throw new Error('no groceries transaction this month');
    const amount = Math.abs(groceries.amount.amountMinor);

    await client.request('PATCH', `/api/transactions/${groceries.id}`, {
      payload: { category: 'travel' },
    });
    const after = (await summary(client)).currencies[0];

    const spent = (block: typeof before, category: string): number =>
      block?.categories.find((c) => c.category === category)?.spentMinor ?? 0;
    expect(spent(after, 'groceries')).toBe(spent(before, 'groceries') - amount);
    expect(spent(after, 'travel')).toBe(spent(before, 'travel') + amount);
    expect(after?.totalOutMinor).toBe(before?.totalOutMinor); // the same money, filed elsewhere
  });

  it('takes a period of the customer’s choosing', async () => {
    const { client } = await connected();
    const month = await summary(client, '?from=2026-09-01&to=2026-09-30');
    expect(month).toMatchObject({ from: '2026-09-01', to: '2026-09-30' });
    expect(month.currencies[0]?.months).toHaveLength(1);

    const sum = (await summary(client, '?from=2026-08-01&to=2026-10-31')).currencies[0];
    const parts = await Promise.all(
      ['2026-08', '2026-09', '2026-10'].map((m) =>
        summary(client, `?from=${m}-01&to=${m}-${m === '2026-09' ? '30' : '31'}`),
      ),
    );
    expect(parts.reduce((total, p) => total + (p.currencies[0]?.totalOutMinor ?? 0), 0)).toBe(
      sum?.totalOutMinor,
    );
  });

  it('refuses nonsense periods', async () => {
    const { client } = await connected();
    expect(
      (await client.get('/api/insights/summary?from=2026-10-01&to=2026-09-01')).statusCode,
    ).toBe(400);
    expect(
      (await client.get('/api/insights/summary?from=2020-01-01&to=2026-10-01')).statusCode,
    ).toBe(400);
    expect((await client.get('/api/insights/summary?from=yesterday')).statusCode).toBe(400);
  });

  it('is empty before a bank is connected, and never shows another customer’s money', async () => {
    t = await createTestApp();
    const empty = await newClient(t);
    expect(await summary(empty)).toMatchObject({ currencies: [], recurring: [] });

    const owner = await newClient(t);
    await owner.connectBank();
    expect((await summary(owner)).currencies).toHaveLength(1);
    expect((await summary(empty)).currencies).toHaveLength(0);
  });
});

describe('the CSV export', () => {
  const lines = (csv: string): string[] =>
    csv
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split('\r\n');

  it('downloads every matching transaction as a spreadsheet, with a header and signed amounts', async () => {
    const { client } = await connected();
    const response = await client.get('/api/transactions/export.csv');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="ledger-lens-transactions-2026-10-28.csv"',
    );
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body.startsWith('\uFEFF')).toBe(true);

    const rows = lines(response.body);
    expect(rows[0]).toBe('Date,Status,Account,Description,Counterparty,Category,Amount,Currency');
    const total = (await page(client)).total;
    expect(rows.length - 1).toBe(total);
    expect(rows.some((row) => /,-\d+\.\d\d,EUR$/.test(row))).toBe(true);
    expect(rows.some((row) => /,\d+\.\d\d,EUR$/.test(row))).toBe(true);
  });

  it('applies the same filters as the list', async () => {
    const { client } = await connected();
    const expected = (await page(client, '&category=groceries')).total;
    const rows = lines((await client.get('/api/transactions/export.csv?category=groceries')).body);
    expect(rows.length - 1).toBe(expected);
    expect(rows.slice(1).every((row) => row.includes(',groceries,'))).toBe(true);

    const none = lines((await client.get('/api/transactions/export.csv?q=zzzznothing')).body);
    expect(none).toHaveLength(1); // just the header
  });

  it('defuses cells a spreadsheet would run as formulas, but keeps negative numbers numeric', async () => {
    const { client, accountId } = await connected();
    t.ctx.repos.transactions.upsertBooked(accountId, [
      {
        providerTxnId: 'evil-1',
        bookedAt: '2026-10-27T10:00:00.000Z',
        amountMinor: -1_234,
        currency: 'EUR',
        description: '=HYPERLINK("http://evil.example","pay")',
        counterparty: '@SUM(1+1)',
        category: 'other',
      },
      {
        providerTxnId: 'quotes-1',
        bookedAt: '2026-10-27T11:00:00.000Z',
        amountMinor: -500,
        currency: 'EUR',
        description: 'Say "hello", then go',
        counterparty: null,
        category: 'other',
      },
    ]);
    const csv = (await client.get('/api/transactions/export.csv?q=hello')).body;
    expect(csv).toContain('"Say ""hello"", then go"');

    const evil = (await client.get('/api/transactions/export.csv?q=hyperlink')).body;
    expect(evil).toContain(`"'=HYPERLINK(""http://evil.example"",""pay"")"`);
    expect(evil).toContain(`'@SUM(1+1)`);
    expect(evil).toContain(',-12.34,EUR');
    expect(evil).not.toMatch(/(^|,)=HYPERLINK/m);
  });

  it('only ever contains the caller’s own transactions', async () => {
    const { client } = await connected();
    const stranger = await newClient(t);
    const theirs = lines((await stranger.get('/api/transactions/export.csv')).body);
    expect(theirs).toHaveLength(1);
    expect(lines((await client.get('/api/transactions/export.csv')).body).length).toBeGreaterThan(
      50,
    );
  });

  it('refuses a period that makes no sense, and needs a session', async () => {
    const { client } = await connected();
    expect(
      (await client.get('/api/transactions/export.csv?from=2026-10-02&to=2026-10-01')).statusCode,
    ).toBe(400);
    const anonymous = await t.app.inject({ method: 'GET', url: '/api/transactions/export.csv' });
    expect(anonymous.statusCode).toBe(401);
  });
});
