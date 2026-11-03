import type { Account } from '@ledger-lens/contracts';
import type { AccountRecord } from '../../db/repos';
import type { RateTable } from '../../domain/rates';

export function toAccountDto(
  account: AccountRecord,
  state: { pending: number; done: number } | undefined,
  table: RateTable,
): Account {
  const ownMinor = account.balanceMinor - account.creditLimitMinor;
  const pending = state?.pending ?? 0;
  return {
    id: account.id,
    kind: account.kind,
    type: account.cardType,
    name: account.name,
    currency: account.currency,
    last4: account.last4,
    ownMinor,
    availableMinor: account.balanceMinor,
    creditLimitMinor: account.creditLimitMinor,
    goalMinor: account.goalMinor,
    ownUahMinor: table.toUahMinor(ownMinor, account.currency),
    history: {
      state: pending > 0 ? (account.coveredFrom ? 'loading' : 'queued') : 'done',
      from: account.coveredFrom,
    },
  };
}
