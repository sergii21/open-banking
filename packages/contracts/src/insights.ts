import { z } from 'zod';
import { Currency, Id, IsoDate, IsoDateTime, Money } from './common';
import { Category } from './transactions';

export const InsightsQuery = z.object({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
});
export type InsightsQuery = z.infer<typeof InsightsQuery>;

export const CategoryTotal = z.object({
  category: Category,
  spentMinor: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  /** Share of this currency's total spend, 0..1. */
  share: z.number().min(0).max(1),
});
export type CategoryTotal = z.infer<typeof CategoryTotal>;

export const MonthlyFlow = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  inMinor: z.number().int().nonnegative(),
  outMinor: z.number().int().nonnegative(),
});
export type MonthlyFlow = z.infer<typeof MonthlyFlow>;

export const RecurringPayment = z.object({
  key: z.string(),
  merchant: z.string(),
  category: Category,
  cadence: z.enum(['weekly', 'monthly', 'quarterly', 'yearly']),
  /** Typical charge, negative (money out). */
  amount: Money,
  occurrences: z.number().int().min(2),
  lastSeenAt: IsoDateTime,
  nextExpectedAt: IsoDateTime,
  accountId: Id,
  /** What this costs per month, for ranking and the monthly total. */
  monthlyEquivalentMinor: z.number().int().nonnegative(),
});
export type RecurringPayment = z.infer<typeof RecurringPayment>;

export const CurrencyInsights = z.object({
  currency: Currency,
  totalInMinor: z.number().int().nonnegative(),
  totalOutMinor: z.number().int().nonnegative(),
  netMinor: z.number().int(),
  categories: z.array(CategoryTotal),
  months: z.array(MonthlyFlow),
});
export type CurrencyInsights = z.infer<typeof CurrencyInsights>;

export const InsightsSummary = z.object({
  from: IsoDate,
  to: IsoDate,
  /** One block per currency: amounts in different currencies are never combined. */
  currencies: z.array(CurrencyInsights),
  recurring: z.array(RecurringPayment),
});
export type InsightsSummary = z.infer<typeof InsightsSummary>;
