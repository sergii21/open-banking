import type {
  Category,
  CategoryTotal,
  CurrencyInsights,
  MonthlyFlow,
  RecurringPayment,
} from '@ledger-lens/contracts';

/** The part of a transaction the insights need. Amounts are signed minor units: negative is money out. */
export interface InsightTransaction {
  id: string;
  accountId: string;
  /** ISO 8601 timestamp (UTC). */
  bookedAt: string;
  amountMinor: number;
  currency: string;
  description: string;
  counterparty: string | null;
  category: Category;
}

/**
 * What counts, stated once so the screen and the tests agree:
 *  - Transfers move money between people and accounts without being spending or earning, so they are left out of every figure.
 *  - Income is money in under the `income` category.
 *  - Spending is money out under any other category, net of refunds: a refund is a positive amount in a spending category, and it
 *    reduces that category's spending for the month it arrives instead of counting as income.
 *  - Pending items are not booked yet, so callers pass booked transactions only.
 *  - Currencies are never combined: every figure belongs to exactly one currency.
 */
const EXCLUDED: ReadonlySet<Category> = new Set<Category>(['transfers']);

const dayOf = (iso: string): string => iso.slice(0, 10);
const monthOf = (iso: string): string => iso.slice(0, 7);

/** Every `YYYY-MM` from the window's first month to its last, so a month with no activity is a zero rather than a gap. */
export function monthsBetween(from: string, to: string): string[] {
  const months: string[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const last = to.slice(0, 7);
  for (;;) {
    const label = `${year}-${String(month).padStart(2, '0')}`;
    if (label > last) break;
    months.push(label);
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

/**
 * Totals per currency for a window (inclusive calendar dates). Spending is netted per category and month and floored at
 * zero at that grain, so that the category totals, the monthly bars and the grand total always add up to the same figure.
 */
export function summarise(
  transactions: readonly InsightTransaction[],
  window: { from: string; to: string },
): CurrencyInsights[] {
  const months = monthsBetween(window.from, window.to);
  const byCurrency = new Map<string, InsightTransaction[]>();
  for (const transaction of transactions) {
    const day = dayOf(transaction.bookedAt);
    if (day < window.from || day > window.to || EXCLUDED.has(transaction.category)) continue;
    byCurrency.set(transaction.currency, [
      ...(byCurrency.get(transaction.currency) ?? []),
      transaction,
    ]);
  }

  return [...byCurrency]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, rows]) => {
      const income = new Map<string, number>();
      const spend = new Map<string, number>();
      const outgoing = new Map<Category, number>();
      for (const row of rows) {
        const month = monthOf(row.bookedAt);
        if (row.category === 'income') {
          income.set(month, (income.get(month) ?? 0) + row.amountMinor);
          continue;
        }
        const cell = `${month}|${row.category}`;
        spend.set(cell, (spend.get(cell) ?? 0) - row.amountMinor);
        if (row.amountMinor < 0) outgoing.set(row.category, (outgoing.get(row.category) ?? 0) + 1);
      }

      const spendByCategory = new Map<Category, number>();
      const spendByMonth = new Map<string, number>();
      for (const [cell, net] of spend) {
        const [month = '', category = 'other'] = cell.split('|') as [string, Category];
        const amount = Math.max(0, net);
        spendByCategory.set(category, (spendByCategory.get(category) ?? 0) + amount);
        spendByMonth.set(month, (spendByMonth.get(month) ?? 0) + amount);
      }

      const totalOutMinor = [...spendByCategory.values()].reduce((sum, value) => sum + value, 0);
      const flows: MonthlyFlow[] = months.map((month) => ({
        month,
        inMinor: Math.max(0, income.get(month) ?? 0),
        outMinor: spendByMonth.get(month) ?? 0,
      }));
      const totalInMinor = flows.reduce((sum, flow) => sum + flow.inMinor, 0);
      const categories: CategoryTotal[] = [...spendByCategory]
        .filter(([, amount]) => amount > 0)
        .sort(([ca, a], [cb, b]) => b - a || ca.localeCompare(cb))
        .map(([category, spentMinor]) => ({
          category,
          spentMinor,
          count: outgoing.get(category) ?? 0,
          share: totalOutMinor === 0 ? 0 : spentMinor / totalOutMinor,
        }));

      return {
        currency,
        totalInMinor,
        totalOutMinor,
        netMinor: totalInMinor - totalOutMinor,
        categories,
        months: flows,
      };
    });
}

// ================================================================================================= recurring

type Cadence = RecurringPayment['cadence'];

interface CadenceRule {
  cadence: Cadence;
  /** The usual number of days between payments. */
  nominalDays: number;
  /** The median gap must fall in this range to be called this cadence. */
  range: [number, number];
  /** How many payments it takes to call it a pattern. Rarer cadences have fewer chances to repeat, so need fewer. */
  minOccurrences: number;
  monthsPerCharge: number;
}

const RULES: readonly CadenceRule[] = [
  {
    cadence: 'weekly',
    nominalDays: 7,
    range: [5, 9],
    minOccurrences: 4,
    monthsPerCharge: 7 / 30.4375,
  },
  {
    cadence: 'monthly',
    nominalDays: 30.4375,
    range: [26, 35],
    minOccurrences: 3,
    monthsPerCharge: 1,
  },
  {
    cadence: 'quarterly',
    nominalDays: 91.3,
    range: [84, 100],
    minOccurrences: 2,
    monthsPerCharge: 3,
  },
  {
    cadence: 'yearly',
    nominalDays: 365.25,
    range: [350, 380],
    minOccurrences: 2,
    monthsPerCharge: 12,
  },
];

/** Most gaps must sit near the usual one, and most amounts near the usual amount: that is what makes it a standing payment. */
const SHARE_REGULAR = 0.75;
const AMOUNT_TOLERANCE = 0.25;
/** A payment that has not come for this many cycles has probably stopped. */
const LAPSED_AFTER_CYCLES = 1.6;

const DAY_MS = 86_400_000;
const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
};

/** A stable name for "the same payee": the bank's merchant name when there is one, else the first words of the description. */
export function merchantKey(
  transaction: Pick<InsightTransaction, 'counterparty' | 'description'>,
): string {
  return (transaction.counterparty ?? transaction.description)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 3)
    .join(' ');
}

const titleCase = (text: string): string =>
  text
    .toLowerCase()
    .replace(/(^|[\s/-])(\p{L})/gu, (_, gap: string, letter: string) => gap + letter.toUpperCase());

function addCalendar(iso: string, cadence: Cadence): string {
  const date = new Date(iso);
  switch (cadence) {
    case 'weekly':
      return new Date(date.getTime() + 7 * DAY_MS).toISOString();
    case 'monthly':
      return new Date(
        Date.UTC(
          date.getUTCFullYear(),
          date.getUTCMonth() + 1,
          date.getUTCDate(),
          date.getUTCHours(),
          date.getUTCMinutes(),
        ),
      ).toISOString();
    case 'quarterly':
      return new Date(
        Date.UTC(
          date.getUTCFullYear(),
          date.getUTCMonth() + 3,
          date.getUTCDate(),
          date.getUTCHours(),
          date.getUTCMinutes(),
        ),
      ).toISOString();
    case 'yearly':
      return new Date(
        Date.UTC(
          date.getUTCFullYear() + 1,
          date.getUTCMonth(),
          date.getUTCDate(),
          date.getUTCHours(),
          date.getUTCMinutes(),
        ),
      ).toISOString();
  }
}

/**
 * Standing payments in the history: the same payee, about the same amount, at a steady rhythm (weekly, monthly, quarterly or
 * yearly). Rent, subscriptions, insurance and the like. A series that stopped is not reported.
 */
export function detectRecurring(
  transactions: readonly InsightTransaction[],
  today: Date,
): RecurringPayment[] {
  const groups = new Map<string, InsightTransaction[]>();
  for (const transaction of transactions) {
    if (
      transaction.amountMinor >= 0 ||
      EXCLUDED.has(transaction.category) ||
      transaction.category === 'income'
    )
      continue;
    const name = merchantKey(transaction);
    if (!name) continue;
    const key = `${transaction.currency}:${name}`;
    groups.set(key, [...(groups.get(key) ?? []), transaction]);
  }

  const found: RecurringPayment[] = [];
  for (const [key, rows] of groups) {
    rows.sort((a, b) => a.bookedAt.localeCompare(b.bookedAt) || a.id.localeCompare(b.id));
    if (rows.length < 2) continue;

    const gaps = rows
      .slice(1)
      .map(
        (row, i) =>
          (Date.parse(row.bookedAt) - Date.parse(rows[i]?.bookedAt ?? row.bookedAt)) / DAY_MS,
      );
    const typicalGap = median(gaps);
    const rule = RULES.find(
      (candidate) => typicalGap >= candidate.range[0] && typicalGap <= candidate.range[1],
    );
    if (!rule || rows.length < rule.minOccurrences) continue;

    const tolerance = Math.max(3, rule.nominalDays * 0.15);
    const regularGaps = gaps.filter((gap) => Math.abs(gap - rule.nominalDays) <= tolerance).length;
    if (regularGaps / gaps.length < SHARE_REGULAR) continue;

    const typicalAmount = median(rows.map((row) => Math.abs(row.amountMinor)));
    const steady = rows.filter(
      (row) =>
        Math.abs(Math.abs(row.amountMinor) - typicalAmount) <= typicalAmount * AMOUNT_TOLERANCE,
    ).length;
    if (steady / rows.length < SHARE_REGULAR) continue;

    const last = rows[rows.length - 1];
    if (!last) continue;
    const daysSinceLast = (today.getTime() - Date.parse(last.bookedAt)) / DAY_MS;
    if (daysSinceLast > rule.nominalDays * LAPSED_AFTER_CYCLES) continue;

    const counts = new Map<Category, number>();
    for (const row of rows) counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
    const category = [...counts].sort(([, a], [, b]) => b - a)[0]?.[0] ?? 'other';
    const amountMinor = Math.round(typicalAmount);

    found.push({
      key,
      merchant: last.counterparty ? titleCase(last.counterparty) : titleCase(merchantKey(last)),
      category,
      cadence: rule.cadence,
      amount: { amountMinor: -amountMinor, currency: last.currency },
      occurrences: rows.length,
      lastSeenAt: last.bookedAt,
      nextExpectedAt: addCalendar(last.bookedAt, rule.cadence),
      accountId: last.accountId,
      monthlyEquivalentMinor: Math.round(amountMinor / rule.monthsPerCharge),
    });
  }

  return found.sort(
    (a, b) => b.monthlyEquivalentMinor - a.monthlyEquivalentMinor || a.key.localeCompare(b.key),
  );
}

/** The default window: the current month and the five before it. */
export function defaultWindow(today: Date, monthsBack = 5): { from: string; to: string } {
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - monthsBack, 1));
  return { from: start.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) };
}
