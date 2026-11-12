import { RateTable } from '@api/domain/rates';
import type { ProviderAccount, RatePair } from '@api/providers/port';

export interface AccountLine {
  id: string;
  name: string;
  kind: 'card' | 'jar';
  last4: string | null;
  currency: string;
  /** The person's own money on it, in the account's currency: the balance without the credit limit. */
  ownMinor: number;
  /** The same in hryvnias at monobank's rate, or null when there is no rate for the currency. */
  uahMinor: number | null;
  goalMinor: number | null;
}

export interface Overview {
  /** Your money: every account's own funds in hryvnias. Accounts with no rate are left out and counted in `unvalued`. */
  totalUahMinor: number;
  accounts: AccountLine[];
  unvalued: number;
  /** Some of the total is foreign currency valued at monobank's rate. */
  converted: boolean;
  /** When monobank last updated its rates, ISO, or null without rates. */
  ratesAsOf: string | null;
}

/** Integer minor units all the way: a foreign balance becomes whole kopiykas the moment it is valued. */
export function buildOverview(
  accounts: readonly ProviderAccount[],
  rates: readonly RatePair[],
): Overview {
  const table = new RateTable(rates);
  let totalUahMinor = 0;
  let unvalued = 0;
  let converted = false;
  const lines = accounts.map((account): AccountLine => {
    // monobank reports the balance with the credit limit in it (an assumption the server's doctor checks).
    const ownMinor = account.balanceMinor - account.creditLimitMinor;
    const uahMinor = table.toUahMinor(ownMinor, account.currency);
    if (uahMinor === null) unvalued += 1;
    else {
      totalUahMinor += uahMinor;
      if (account.currency !== 'UAH') converted = true;
    }
    return {
      id: account.providerAccountId,
      name: account.name,
      kind: account.kind,
      last4: account.last4,
      currency: account.currency,
      ownMinor,
      uahMinor,
      goalMinor: account.goalMinor,
    };
  });
  return { totalUahMinor, accounts: lines, unvalued, converted, ratesAsOf: table.asOf() };
}
