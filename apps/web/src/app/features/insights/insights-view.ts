import type { MonthlyFlow, RecurringPayment } from '@ledger-lens/contracts';
import type { SegmentOption } from '../../shared/segmented/segmented';
import { formatMoney } from '../../shared/format';

export type Period = '3' | '6' | '12';

export const PERIODS: readonly SegmentOption<Period>[] = [
  { value: '3', label: '3 months' },
  { value: '6', label: '6 months' },
  { value: '12', label: '12 months' },
];

/** The first day of the month `months - 1` months before `now`'s: "6 months" is this month and the five before it. */
export function periodStart(now: Date, months: number): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1))
    .toISOString()
    .slice(0, 10);
}

const MONTH = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' });
const MONTH_YEAR = new Intl.DateTimeFormat('en-GB', {
  month: 'short',
  year: '2-digit',
  timeZone: 'UTC',
});

/** "May", "Jun", ... and, when the window crosses a year end, "Nov 25", "Dec 25", "Jan 26" so the reader can tell the years apart. */
export function monthLabels(months: readonly string[]): string[] {
  const years = new Set(months.map((month) => month.slice(0, 4)));
  return months.map((month) => {
    const date = new Date(`${month}-01T00:00:00Z`);
    return (years.size > 1 ? MONTH_YEAR : MONTH).format(date);
  });
}

/** The long form of a month for sentences and tables: "October 2026". */
export const monthName = (month: string): string =>
  new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${month}-01T00:00:00Z`),
  );

export const CADENCE_LABEL: Record<RecurringPayment['cadence'], string> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Every 3 months',
  yearly: 'Yearly',
};

/** One sentence that says what the chart shows, for people who will not see it. */
export function describeMonths(months: readonly MonthlyFlow[], currency: string): string {
  const active = months.filter((flow) => flow.inMinor > 0 || flow.outMinor > 0);
  if (active.length === 0) return `No income or spending in ${currency} in this period.`;
  const overspent = active.filter((flow) => flow.outMinor > flow.inMinor).length;
  const biggest = active.reduce((top, flow) => (flow.outMinor > top.outMinor ? flow : top));
  return (
    `Income and spending by month in ${currency}. Spending was higher than income in ${overspent} of ` +
    `${active.length} ${active.length === 1 ? 'month' : 'months'}; the most was spent in ` +
    `${monthName(biggest.month)} (${formatMoney(biggest.outMinor, currency)}).`
  );
}

/** What the standing payments of one currency cost each month, in total. */
export const monthlyCommitment = (payments: readonly RecurringPayment[]): number =>
  payments.reduce((sum, payment) => sum + payment.monthlyEquivalentMinor, 0);
