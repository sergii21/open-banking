import type { AccountRecord, TransactionRecord } from '../db/repos';
import type { Calendar } from './calendar';
import type { InsightTransaction } from './insights';
import type { RateTable } from './rates';

export interface UahRows {
  /** Every transaction valued in hryvnias, newest first, with the person's calendar day on it. */
  items: InsightTransaction[];
  /** Rows left out because monobank publishes no rate for their currency. */
  skipped: number;
  /** Some rows were foreign currency and were converted at today's rate. */
  converted: boolean;
}

/**
 * The insights and Home figures are in hryvnias, because that is what the person thinks in. A foreign-currency row is
 * valued at today's rate (monobank publishes no history of rates), and the screens say so wherever that matters.
 */
export function toUahRows(
  rows: readonly TransactionRecord[],
  accounts: readonly AccountRecord[],
  table: RateTable,
  calendar: Calendar,
): UahRows {
  const known = new Set(accounts.map((a) => a.id));
  const items: InsightTransaction[] = [];
  let skipped = 0;
  let converted = false;
  for (const row of rows) {
    if (!known.has(row.accountId)) continue;
    const amountMinor = table.toUahMinor(row.amountMinor, row.currency);
    if (amountMinor === null) {
      skipped += 1;
      continue;
    }
    if (row.currency !== 'UAH') converted = true;
    items.push({
      id: row.id,
      accountId: row.accountId,
      bookedAt: new Date(row.ts).toISOString(),
      day: calendar.dayKey(row.ts),
      amountMinor,
      currency: 'UAH',
      description: row.description,
      counterparty: row.counterparty,
      category: row.category,
    });
  }
  return { items, skipped, converted };
}

/**
 * Spending per day: money out in any category except transfers and income, net of refunds in the same day, never below
 * zero. Home's bars, its month totals and the comparison with last month all come from this one rule.
 */
export function dailySpend(
  items: readonly InsightTransaction[],
  from: string,
  to: string,
): Map<string, number> {
  const days = new Map<string, number>();
  for (const item of items) {
    if (item.day < from || item.day > to) continue;
    if (item.category === 'transfers' || item.category === 'income') continue;
    days.set(item.day, (days.get(item.day) ?? 0) - item.amountMinor);
  }
  for (const [day, value] of days) days.set(day, Math.max(0, value));
  return days;
}

export const sumMap = (map: ReadonlyMap<string, number>): number => {
  let total = 0;
  for (const value of map.values()) total += value;
  return total;
};
