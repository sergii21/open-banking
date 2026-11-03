/**
 * Checks of the two things monobank's published spec does not state, run on real data with counts only:
 *  - a statement item's `balance` is the balance after that operation, so consecutive items agree:
 *    balance(newer) = balance(older) + amount(newer);
 *  - an account's `balance` includes its credit limit.
 */
export interface BalanceRow {
  ts: number;
  amountMinor: number;
  balanceAfterMinor: number | null;
  pending: boolean;
}

export function statementContinuity(rows: readonly BalanceRow[]): {
  pairs: number;
  consistent: number;
} {
  const booked = rows
    .filter((row) => !row.pending && row.balanceAfterMinor !== null)
    .sort((a, b) => a.ts - b.ts);
  let pairs = 0;
  let consistent = 0;
  for (let i = 1; i < booked.length; i += 1) {
    const older = booked[i - 1];
    const newer = booked[i];
    if (!older || !newer || older.balanceAfterMinor === null || newer.balanceAfterMinor === null)
      continue;
    pairs += 1;
    if (older.balanceAfterMinor + newer.amountMinor === newer.balanceAfterMinor) consistent += 1;
  }
  return { pairs, consistent };
}

/** Where a credit card's reported balance sits against its limit, as a bucket instead of an amount. */
export function balanceVersusLimit(
  balanceMinor: number,
  creditLimitMinor: number,
): 'above' | 'equal' | 'below' {
  if (balanceMinor === creditLimitMinor) return 'equal';
  return balanceMinor > creditLimitMinor ? 'above' : 'below';
}
