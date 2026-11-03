import type { Category } from '@ledger-lens/contracts';
import { describe, expect, it } from 'vitest';
import {
  detectRecurring,
  merchantKey,
  monthsBetween,
  summarise,
  type InsightTransaction,
} from '../src/domain/insights';

let counter = 0;
function tx(
  date: string,
  amountMinor: number,
  description: string,
  category: Category,
  extra: Partial<InsightTransaction> = {},
): InsightTransaction {
  counter += 1;
  return {
    id: `t${String(counter).padStart(4, '0')}`,
    accountId: 'acc_1',
    bookedAt: `${date}T09:00:00.000Z`,
    day: date,
    amountMinor,
    currency: 'EUR',
    description,
    counterparty: null,
    category,
    ...extra,
  };
}

const WINDOW = { from: '2026-08-01', to: '2026-10-31' };

describe('monthsBetween', () => {
  it('lists every month, including the ones in between and across a year end', () => {
    expect(monthsBetween('2026-08-15', '2026-10-02')).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(monthsBetween('2025-11-01', '2026-02-28')).toEqual([
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
    ]);
    expect(monthsBetween('2026-10-01', '2026-10-31')).toEqual(['2026-10']);
  });
});

describe('summarise', () => {
  const rows = [
    tx('2026-08-28', 300_000, 'SALARY', 'income'),
    tx('2026-09-28', 300_000, 'SALARY', 'income'),
    tx('2026-08-03', -60_000, 'RENT', 'bills'),
    tx('2026-09-03', -60_000, 'RENT', 'bills'),
    tx('2026-08-10', -4_500, 'REWE', 'groceries'),
    tx('2026-08-17', -3_500, 'LIDL', 'groceries'),
    tx('2026-09-12', -2_000, 'EDEKA', 'groceries'),
    tx('2026-09-20', -1_299, 'NETFLIX', 'subscriptions'),
  ];

  it('adds up spending per category, income and the net, to the cent', () => {
    const [eur] = summarise(rows, WINDOW);
    expect(eur).toMatchObject({
      currency: 'EUR',
      totalInMinor: 600_000,
      totalOutMinor: 131_299,
      netMinor: 468_701,
    });
    expect(eur?.categories.map((c) => [c.category, c.spentMinor, c.count])).toEqual([
      ['bills', 120_000, 2],
      ['groceries', 10_000, 3],
      ['subscriptions', 1_299, 1],
    ]);
  });

  it('gives each category its share of the spending, and the shares add up to one', () => {
    const [eur] = summarise(rows, WINDOW);
    expect(eur?.categories[0]?.share).toBeCloseTo(120_000 / 131_299, 10);
    const sum = eur?.categories.reduce((total, c) => total + c.share, 0) ?? 0;
    expect(sum).toBeCloseTo(1, 10);
  });

  it('shows every month of the window, with zeros for a month nothing happened in', () => {
    const [eur] = summarise(rows, WINDOW);
    expect(eur?.months).toEqual([
      { month: '2026-08', inMinor: 300_000, outMinor: 68_000 },
      { month: '2026-09', inMinor: 300_000, outMinor: 63_299 },
      { month: '2026-10', inMinor: 0, outMinor: 0 },
    ]);
  });

  it('keeps the categories, the months and the total in agreement', () => {
    const [eur] = summarise(rows, WINDOW);
    const byCategory = eur?.categories.reduce((sum, c) => sum + c.spentMinor, 0);
    const byMonth = eur?.months.reduce((sum, m) => sum + m.outMinor, 0);
    expect(byCategory).toBe(eur?.totalOutMinor);
    expect(byMonth).toBe(eur?.totalOutMinor);
  });

  it('leaves transfers out of every figure', () => {
    const [eur] = summarise(
      [
        ...rows,
        tx('2026-09-05', -100_000, 'TO SAVINGS', 'transfers'),
        tx('2026-09-05', 100_000, 'FROM CURRENT', 'transfers'),
      ],
      WINDOW,
    );
    expect(eur?.totalInMinor).toBe(600_000);
    expect(eur?.totalOutMinor).toBe(131_299);
    expect(eur?.categories.some((c) => c.category === 'transfers')).toBe(false);
  });

  it('nets a refund against its category instead of counting it as income', () => {
    const [eur] = summarise(
      [
        tx('2026-09-02', -10_000, 'ZALANDO', 'shopping'),
        tx('2026-09-09', 3_000, 'ZALANDO RETURN', 'shopping'),
      ],
      WINDOW,
    );
    expect(eur?.totalInMinor).toBe(0);
    expect(eur?.totalOutMinor).toBe(7_000);
    expect(eur?.categories).toEqual([
      { category: 'shopping', spentMinor: 7_000, count: 1, share: 1 },
    ]);
  });

  it('never lets a refund make spending negative, and does not carry it into another month', () => {
    const [eur] = summarise(
      [
        tx('2026-08-04', -2_000, 'SHOP', 'shopping'),
        tx('2026-09-04', 5_000, 'SHOP REFUND FOR AUGUST', 'shopping'),
      ],
      WINDOW,
    );
    expect(eur?.totalOutMinor).toBe(2_000);
    expect(eur?.months.find((m) => m.month === '2026-09')).toMatchObject({
      inMinor: 0,
      outMinor: 0,
    });
  });

  it('nets a reversed income against income', () => {
    const [eur] = summarise(
      [
        tx('2026-09-28', 300_000, 'SALARY', 'income'),
        tx('2026-09-29', -20_000, 'SALARY CLAWBACK', 'income'),
      ],
      WINDOW,
    );
    expect(eur?.totalInMinor).toBe(280_000);
    expect(eur?.totalOutMinor).toBe(0);
  });

  it('never combines currencies', () => {
    const result = summarise(
      [
        ...rows,
        tx('2026-09-08', -2_500, 'PRET', 'dining', { currency: 'GBP' }),
        tx('2026-09-25', 200_000, 'SALARY', 'income', { currency: 'GBP' }),
      ],
      WINDOW,
    );
    expect(result.map((r) => r.currency)).toEqual(['EUR', 'GBP']);
    expect(result[0]?.totalOutMinor).toBe(131_299);
    expect(result[1]).toMatchObject({
      currency: 'GBP',
      totalInMinor: 200_000,
      totalOutMinor: 2_500,
    });
  });

  it('counts only the window, both ends included', () => {
    const [eur] = summarise(
      [
        tx('2026-07-31', -1_000, 'BEFORE', 'other'),
        tx('2026-08-01', -2_000, 'FIRST DAY', 'other'),
        tx('2026-10-31', -4_000, 'LAST DAY', 'other'),
        tx('2026-11-01', -8_000, 'AFTER', 'other'),
      ],
      WINDOW,
    );
    expect(eur?.totalOutMinor).toBe(6_000);
  });

  it('is empty when there is nothing to report', () => {
    expect(summarise([], WINDOW)).toEqual([]);
    expect(summarise([tx('2026-09-05', -100, 'TO SAVINGS', 'transfers')], WINDOW)).toEqual([]);
  });

  it('shares nothing out of zero spending', () => {
    const [eur] = summarise([tx('2026-09-28', 100, 'SALARY', 'income')], WINDOW);
    expect(eur).toMatchObject({ totalInMinor: 100, totalOutMinor: 0, categories: [] });
  });
});

describe('merchantKey', () => {
  it('prefers the bank’s merchant name and ignores digits, punctuation and accents', () => {
    expect(merchantKey({ counterparty: 'SPOTIFY', description: 'SPOTIFY P1A2B3' })).toBe('spotify');
    expect(merchantKey({ counterparty: null, description: 'NETFLIX.COM 8821' })).toBe(
      'netflix com',
    );
    expect(merchantKey({ counterparty: null, description: 'NETFLIX.COM 7710' })).toBe(
      'netflix com',
    );
    expect(merchantKey({ counterparty: null, description: 'Café Müller 0042 Berlin Mitte' })).toBe(
      'cafe muller berlin',
    );
  });
});

describe('detectRecurring', () => {
  const TODAY = new Date('2026-10-29T10:00:00Z');
  const monthly = (
    description: string,
    amountMinor: number,
    category: Category,
    dates: string[],
    extra: Partial<InsightTransaction> = {},
  ) => dates.map((date) => tx(date, amountMinor, description, category, extra));

  const SIX_MONTHS = [
    '2026-05-03',
    '2026-06-03',
    '2026-07-03',
    '2026-08-03',
    '2026-09-03',
    '2026-10-03',
  ];

  it('finds a standing monthly payment and says when the next one is due', () => {
    const [rent] = detectRecurring(
      monthly('MIETE WOHNUNG MEIER', -60_000, 'bills', SIX_MONTHS),
      TODAY,
    );
    expect(rent).toMatchObject({
      merchant: 'Miete Wohnung Meier',
      category: 'bills',
      cadence: 'monthly',
      amountMinor: 60_000,
      currency: 'EUR',
      occurrences: 6,
      monthlyEquivalentMinor: 60_000,
      lastSeenAt: '2026-10-03T09:00:00.000Z',
      nextExpectedAt: '2026-11-03T09:00:00.000Z',
    });
  });

  it('tolerates a price rise, and days that drift around weekends', () => {
    const rows = [
      tx('2026-05-02', -999, 'NETFLIX.COM', 'subscriptions', { counterparty: 'NETFLIX' }),
      tx('2026-06-03', -999, 'NETFLIX.COM', 'subscriptions', { counterparty: 'NETFLIX' }),
      tx('2026-07-01', -999, 'NETFLIX.COM', 'subscriptions', { counterparty: 'NETFLIX' }),
      tx('2026-08-03', -1_199, 'NETFLIX.COM', 'subscriptions', { counterparty: 'NETFLIX' }),
      tx('2026-09-02', -1_199, 'NETFLIX.COM', 'subscriptions', { counterparty: 'NETFLIX' }),
      tx('2026-10-01', -1_199, 'NETFLIX.COM', 'subscriptions', { counterparty: 'NETFLIX' }),
    ];
    const [netflix] = detectRecurring(rows, TODAY);
    expect(netflix).toMatchObject({ merchant: 'Netflix', cadence: 'monthly', occurrences: 6 });
    expect(netflix?.amountMinor).toBe(1_099); // the typical charge: the median of what was paid
  });

  it('does not mistake frequent shopping at one shop for a standing payment', () => {
    const dates = [
      '2026-09-01',
      '2026-09-04',
      '2026-09-11',
      '2026-09-12',
      '2026-09-20',
      '2026-09-27',
      '2026-10-02',
      '2026-10-10',
    ];
    const amounts = [-2_310, -540, -6_120, -980, -4_450, -1_230, -7_800, -3_090];
    const rows = dates.map((date, i) =>
      tx(date, amounts[i] ?? -1, 'REWE SAGT DANKE', 'groceries', { counterparty: 'REWE' }),
    );
    expect(detectRecurring(rows, TODAY)).toEqual([]);
  });

  it('does not report two payments as a monthly pattern, but does for yearly and quarterly ones', () => {
    expect(
      detectRecurring(monthly('GYM', -2_500, 'health', ['2026-09-03', '2026-10-03']), TODAY),
    ).toEqual([]);

    // With the two months of history loaded by default, a subscription or a utility seen twice a month apart is a pattern.
    const twice = detectRecurring(
      monthly('NETFLIX.COM', -19_900, 'subscriptions', ['2026-09-08', '2026-10-08']),
      TODAY,
    );
    expect(twice[0]).toMatchObject({ cadence: 'monthly', monthlyEquivalentMinor: 19_900 });

    const insurance = detectRecurring(
      monthly('ALLIANZ HAFTPFLICHT', -9_000, 'bills', ['2026-01-15', '2026-04-15', '2026-07-15']),
      TODAY,
    );
    expect(insurance[0]).toMatchObject({ cadence: 'quarterly', monthlyEquivalentMinor: 3_000 });

    const annual = detectRecurring(
      monthly('DOMAIN RENEWAL', -1_800, 'bills', ['2025-03-10', '2026-03-10']),
      new Date('2026-09-01T10:00:00Z'),
    );
    expect(annual[0]).toMatchObject({ cadence: 'yearly', monthlyEquivalentMinor: 150 });
  });

  it('finds weekly payments and converts them to a monthly cost', () => {
    const weekly = detectRecurring(
      monthly('YOGA CLASS', -1_500, 'health', [
        '2026-09-24',
        '2026-10-01',
        '2026-10-08',
        '2026-10-15',
        '2026-10-22',
      ]),
      TODAY,
    );
    expect(weekly[0]).toMatchObject({ cadence: 'weekly', occurrences: 5 });
    // A month is 30.4375 days, so 4.348 weekly charges: 15.00 a week costs 65.22 a month.
    expect(weekly[0]?.monthlyEquivalentMinor).toBe(6_522);
  });

  it('drops a payment that has stopped', () => {
    const stopped = monthly('OLD GYM', -2_500, 'health', [
      '2026-01-03',
      '2026-02-03',
      '2026-03-03',
      '2026-04-03',
    ]);
    expect(detectRecurring(stopped, TODAY)).toEqual([]);
    // The same payments are still live when the last one was recent.
    expect(detectRecurring(stopped, new Date('2026-05-10T10:00:00Z'))).toHaveLength(1);
  });

  it('ignores income, transfers and anything that is not money out', () => {
    const salary = monthly('SALARY ACME', 300_000, 'income', SIX_MONTHS);
    const savings = monthly('MONTHLY SAVINGS', -50_000, 'transfers', SIX_MONTHS);
    const refund = monthly('SHOP REFUND', 1_000, 'shopping', SIX_MONTHS);
    expect(detectRecurring([...salary, ...savings, ...refund], TODAY)).toEqual([]);
  });

  it('keeps currencies apart and ranks by what each costs per month', () => {
    const rows = [
      ...monthly('NETFLIX.COM', -1_299, 'subscriptions', SIX_MONTHS, { counterparty: 'NETFLIX' }),
      ...monthly('NETFLIX.COM', -999, 'subscriptions', SIX_MONTHS, {
        counterparty: 'NETFLIX',
        currency: 'GBP',
      }),
      ...monthly('MIETE', -80_000, 'bills', SIX_MONTHS),
    ];
    const found = detectRecurring(rows, TODAY);
    expect(found.map((r) => [r.key, r.currency])).toEqual([
      ['EUR:miete', 'EUR'],
      ['EUR:netflix', 'EUR'],
      ['GBP:netflix', 'GBP'],
    ]);
  });
});
