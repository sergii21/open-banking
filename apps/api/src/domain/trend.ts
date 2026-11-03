import type { RateTable } from './rates';

export interface TrendAccount {
  currency: string;
  creditLimitMinor: number;
  /** The bank's balance now (includes any credit limit). */
  currentBalanceMinor: number;
  /** First day of statement history loaded, or null when none is. */
  coveredFrom: string | null;
  isJar: boolean;
  /** Statement items that carry a balance, oldest first. */
  rows: readonly { ts: number; amountMinor: number; balanceAfterMinor: number }[];
}

/**
 * Own money per day, from the balance each statement item reports after itself. Needs every card's history to reach back to
 * the first day (otherwise the early days would be guesses and the line would lie), so it returns null until it does. Jars
 * move rarely and load last, so a jar that has not loaded yet is held at its balance now and the result says so.
 */
export function balanceTrend(
  accounts: readonly TrendAccount[],
  days: readonly string[],
  dayEnd: (day: string) => number,
  table: RateTable,
): { points: number[]; approximate: boolean } | null {
  const last = days.length - 1;
  const totals = new Array<number>(days.length).fill(0);
  let approximate = false;

  for (const account of accounts) {
    if (table.toUahMinor(0, account.currency) === null) continue;
    let pointer = -1;
    for (let d = 0; d < days.length; d += 1) {
      const day = days[d];
      let own: number;
      if (d === last) {
        own = account.currentBalanceMinor - account.creditLimitMinor;
      } else {
        const end = dayEnd(day);
        while (
          pointer + 1 < account.rows.length &&
          (account.rows[pointer + 1]?.ts ?? Infinity) <= end
        ) {
          pointer += 1;
        }
        const covered = account.coveredFrom !== null && account.coveredFrom <= day;
        const row = pointer >= 0 ? account.rows[pointer] : undefined;
        if (row) {
          own = row.balanceAfterMinor - account.creditLimitMinor;
        } else if (covered) {
          // Nothing happened before this day within the loaded history: the balance was what the first item started from.
          const first = account.rows[0];
          own =
            (first ? first.balanceAfterMinor - first.amountMinor : account.currentBalanceMinor) -
            account.creditLimitMinor;
        } else if (account.isJar) {
          approximate = true;
          own = account.currentBalanceMinor - account.creditLimitMinor;
        } else {
          return null;
        }
      }
      totals[d] = (totals[d] ?? 0) + (table.toUahMinor(own, account.currency) ?? 0);
    }
  }
  return { points: totals, approximate };
}
