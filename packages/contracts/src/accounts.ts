import * as z from 'zod';
import { Id, IsoDateTime, Money } from './common';

export const AccountType = z.enum(['current', 'savings', 'credit_card', 'other']);
export type AccountType = z.infer<typeof AccountType>;

export const Account = z.object({
  id: Id,
  connectionId: Id,
  institutionId: z.string(),
  institutionName: z.string(),
  name: z.string(),
  type: AccountType,
  currency: z.string().length(3),
  /** Masked identifier only (e.g. `DE•• •••• 4321`); the full IBAN never leaves the server. */
  maskedIdentifier: z.string().nullable(),
  balance: Money,
  availableBalance: Money.nullable(),
  balanceAt: IsoDateTime,
  lastRefreshedAt: IsoDateTime,
});
export type Account = z.infer<typeof Account>;

export const AccountList = z.object({ items: z.array(Account) });
export type AccountList = z.infer<typeof AccountList>;

export const RefreshAccountResponse = z.object({
  account: Account,
  newTransactions: z.number().int().nonnegative(),
});
export type RefreshAccountResponse = z.infer<typeof RefreshAccountResponse>;
