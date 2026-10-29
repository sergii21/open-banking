import type { MonthlyFlow, RecurringPayment } from '@ledger-lens/contracts';
import {
  describeMonths,
  monthLabels,
  monthlyCommitment,
  monthName,
  periodStart,
} from './insights-view';

describe('periodStart', () => {
  it('starts "6 months" at the first of the month five months back', () => {
    expect(periodStart(new Date('2026-10-29T10:00:00Z'), 6)).toBe('2026-05-01');
    expect(periodStart(new Date('2026-10-29T10:00:00Z'), 3)).toBe('2026-08-01');
    expect(periodStart(new Date('2026-10-29T10:00:00Z'), 12)).toBe('2025-11-01');
    expect(periodStart(new Date('2026-01-03T10:00:00Z'), 6)).toBe('2025-08-01');
  });
});

describe('monthLabels', () => {
  it('names the months, and adds the year only when the window crosses one', () => {
    expect(monthLabels(['2026-05', '2026-06', '2026-07'])).toEqual(['May', 'Jun', 'Jul']);
    expect(monthLabels(['2025-12', '2026-01'])).toEqual(['Dec 25', 'Jan 26']);
  });

  it('spells a month out for sentences', () => {
    expect(monthName('2026-10')).toBe('October 2026');
  });
});

describe('describeMonths', () => {
  const flows: MonthlyFlow[] = [
    { month: '2026-08', inMinor: 300_000, outMinor: 280_000 },
    { month: '2026-09', inMinor: 300_000, outMinor: 320_000 },
    { month: '2026-10', inMinor: 0, outMinor: 0 },
  ];

  it('says in words what the chart shows, counting only months with activity', () => {
    expect(describeMonths(flows, 'EUR')).toBe(
      'Income and spending by month in EUR. Spending was higher than income in 1 of 2 months; the most was spent in September 2026 (€3,200.00).',
    );
  });

  it('copes with nothing to describe', () => {
    expect(describeMonths([{ month: '2026-10', inMinor: 0, outMinor: 0 }], 'GBP')).toBe(
      'No income or spending in GBP in this period.',
    );
  });
});

describe('monthlyCommitment', () => {
  it('adds up what the standing payments cost per month', () => {
    const payment = (monthlyEquivalentMinor: number): RecurringPayment => ({
      key: `k${monthlyEquivalentMinor}`,
      merchant: 'X',
      category: 'bills',
      cadence: 'monthly',
      amount: { amountMinor: -monthlyEquivalentMinor, currency: 'EUR' },
      occurrences: 3,
      lastSeenAt: '2026-10-01T00:00:00.000Z',
      nextExpectedAt: '2026-11-01T00:00:00.000Z',
      accountId: 'acc_1',
      monthlyEquivalentMinor,
    });
    expect(monthlyCommitment([payment(60_000), payment(1_299), payment(3_000)])).toBe(64_299);
    expect(monthlyCommitment([])).toBe(0);
  });
});
