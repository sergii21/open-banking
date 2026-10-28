import * as z from 'zod';
import { Id, IsoDate, IsoDateTime, Money } from './common';

export const Category = z.enum([
  'groceries',
  'dining',
  'transport',
  'shopping',
  'housing',
  'bills',
  'subscriptions',
  'entertainment',
  'health',
  'travel',
  'transfers',
  'income',
  'other',
]);
export type Category = z.infer<typeof Category>;

export const CATEGORIES = Category.options;

export const TransactionStatus = z.enum(['pending', 'booked']);
export type TransactionStatus = z.infer<typeof TransactionStatus>;

export const Transaction = z.object({
  id: Id,
  accountId: Id,
  /** Booking time; for pending items, when the bank first reported them. */
  bookedAt: IsoDateTime,
  status: TransactionStatus,
  /** Signed: negative is money leaving the account. */
  amount: Money,
  description: z.string(),
  counterparty: z.string().nullable(),
  category: Category,
  categorySource: z.enum(['auto', 'user']),
});
export type Transaction = z.infer<typeof Transaction>;

export const TransactionQuery = z.object({
  accountId: Id.optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
  q: z.string().trim().max(80).optional(),
  category: Category.optional(),
  status: TransactionStatus.optional(),
  direction: z.enum(['in', 'out']).optional(),
  /** Bounds apply to the absolute amount, in minor units. */
  minAmountMinor: z.coerce.number().int().nonnegative().optional(),
  maxAmountMinor: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});
export type TransactionQuery = z.infer<typeof TransactionQuery>;

export const TransactionPage = z.object({
  items: z.array(Transaction),
  nextCursor: z.string().nullable(),
  /** Number of rows matching the filter, before paging. */
  total: z.number().int().nonnegative(),
});
export type TransactionPage = z.infer<typeof TransactionPage>;

export const UpdateTransactionRequest = z.object({ category: Category });
export type UpdateTransactionRequest = z.infer<typeof UpdateTransactionRequest>;
