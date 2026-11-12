import { addMonthsToDay, type Calendar } from '@api/domain/calendar';
import { summarise, type InsightTransaction } from '@api/domain/insights';
import { RateTable } from '@api/domain/rates';
import type { ProviderAccount, RatePair } from '@api/providers/port';
import {
  FAMILY_SUMMARY_VERSION,
  type Category,
  type FamilyBudget,
  type FamilyMonth,
  type FamilySummary,
} from '@ledger-lens/contracts';
import type { TransactionRow } from '../data/db';
import { buildOverview } from '../model/overview';

/** The months a summary carries: this one and the one before, as `YYYY-MM`. */
export function summaryMonths(today: string): [string, string] {
  return [today.slice(0, 7), addMonthsToDay(`${today.slice(0, 7)}-01`, -1).slice(0, 7)];
}

/**
 * What this phone tells the family: totals of the month per category, in hryvnias, and (if the person shares it) their
 * money. No transaction, merchant, account or card leaves the phone. Spending follows the rules of Insights (net of
 * refunds, transfers left out); a foreign-currency amount is valued at monobank's rate of today, and one with no rate
 * is left out.
 */
export function buildOwnSummary(input: {
  memberId: string;
  name: string;
  now: number;
  calendar: Calendar;
  /** False without a real bank (nothing connected, or the demo): no figures are shared then. */
  live: boolean;
  shareBalance: boolean;
  accounts: readonly ProviderAccount[];
  rates: readonly RatePair[];
  /** Booked rows covering at least the two months. */
  transactions: readonly TransactionRow[];
  budget: FamilyBudget | null;
}): FamilySummary {
  const base = {
    v: FAMILY_SUMMARY_VERSION,
    memberId: input.memberId,
    name: input.name,
    updatedAt: input.now,
    budget: input.budget,
  } as const;
  if (!input.live) return { ...base, balanceMinor: null, months: [] };

  const table = new RateTable(input.rates);
  const rows = input.transactions.map((row): InsightTransaction => ({
    id: row.id,
    accountId: row.accountId,
    bookedAt: new Date(row.ts).toISOString(),
    day: input.calendar.dayKey(row.ts),
    amountMinor: row.amountMinor,
    currency: row.currency,
    description: '',
    counterparty: null,
    category: row.category,
  }));
  const months = summaryMonths(input.calendar.dayKey(input.now)).map((month): FamilyMonth => {
    const byCategory: Partial<Record<Category, number>> = {};
    let spentMinor = 0;
    let incomeMinor = 0;
    for (const currency of summarise(rows, { from: `${month}-01`, to: `${month}-31` })) {
      for (const { category, spentMinor: amount } of currency.categories) {
        const uah = table.toUahMinor(amount, currency.currency);
        if (uah === null || uah <= 0) continue;
        byCategory[category] = (byCategory[category] ?? 0) + uah;
        spentMinor += uah;
      }
      incomeMinor += Math.max(0, table.toUahMinor(currency.totalInMinor, currency.currency) ?? 0);
    }
    return { month, spentMinor, incomeMinor, byCategory };
  });
  return {
    ...base,
    balanceMinor: input.shareBalance
      ? buildOverview(input.accounts, input.rates).totalUahMinor
      : null,
    months,
  };
}
