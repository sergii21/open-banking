import type { Account } from '@ledger-lens/contracts';
import type { AccountRecord, ConnectionRecord } from '../../db/repos';
import type { RateTable } from '../../domain/rates';
import { BANK_OF } from '../connection/presenter';

export function toAccountDto(
  account: AccountRecord,
  state: { pending: number; done: number } | undefined,
  table: RateTable,
  connection: ConnectionRecord | undefined,
): Account {
  // An imported statement may carry no balance. It is then shown as unknown, never as zero.
  const ownMinor = account.balanceKnown ? account.balanceMinor - account.creditLimitMinor : 0;
  const pending = state?.pending ?? 0;
  const file = connection?.kind === 'file';
  return {
    id: account.id,
    connectionId: account.connectionId,
    bank: BANK_OF[connection?.provider ?? 'monobank'],
    source: file ? 'file' : 'api',
    kind: account.kind,
    type: account.cardType,
    name: account.name,
    currency: account.currency,
    last4: account.last4,
    balanceKnown: account.balanceKnown,
    imported:
      file && account.coveredFrom && account.coveredTo
        ? {
            from: account.coveredFrom,
            to: account.coveredTo,
            at: account.lastStatementAt ?? account.balanceAt,
          }
        : null,
    ownMinor,
    availableMinor: account.balanceKnown ? account.balanceMinor : 0,
    creditLimitMinor: account.creditLimitMinor,
    goalMinor: account.goalMinor,
    ownUahMinor: account.balanceKnown ? table.toUahMinor(ownMinor, account.currency) : null,
    history: {
      state: pending > 0 ? (account.coveredFrom ? 'loading' : 'queued') : 'done',
      from: account.coveredFrom,
    },
  };
}
