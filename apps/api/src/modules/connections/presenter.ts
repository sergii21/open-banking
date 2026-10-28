import type {
  Account,
  Connection,
  ProviderId,
  ProviderMode,
  Transaction,
} from '@ledger-lens/contracts';
import { consentView } from '../../domain/consent';
import type { AccountWithConnection, ConnectionRecord, TransactionRecord } from '../../db/repos';
import type { CoreContext } from '../../types';

export const MODE_BY_PROVIDER: Record<ProviderId, ProviderMode> = {
  mock: 'mock',
  truelayer: 'sandbox',
  enablebanking: 'live',
  monobank: 'live',
};

export function toConnectionDto(core: CoreContext, record: ConnectionRecord): Connection {
  const consent = consentView(record.consentExpiresAt, record.status, core.clock.now());
  return {
    id: record.id,
    provider: record.provider,
    mode: MODE_BY_PROVIDER[record.provider],
    institutionId: record.institutionId,
    institutionName: record.institutionName,
    institutionLogoUrl: record.institutionLogoUrl,
    status: record.status,
    permissions: record.permissions,
    createdAt: record.createdAt,
    consentExpiresAt: record.consentExpiresAt,
    consentState: consent.state,
    consentDaysRemaining: consent.daysRemaining,
    lastRefreshedAt: record.lastRefreshedAt,
    accountCount: core.repos.connections.accountCount(record.id),
    sync: core.repos.syncJobs.progress(record.id),
  };
}

export function toAccountDto(account: AccountWithConnection): Account {
  return {
    id: account.id,
    connectionId: account.connectionId,
    institutionId: account.institutionId,
    institutionName: account.institutionName,
    name: account.name,
    type: account.type,
    currency: account.currency,
    maskedIdentifier: account.maskedIdentifier,
    balance: { amountMinor: account.balanceMinor, currency: account.currency },
    availableBalance:
      account.availableMinor === null
        ? null
        : { amountMinor: account.availableMinor, currency: account.currency },
    balanceAt: account.balanceAt,
    lastRefreshedAt: account.lastRefreshedAt,
  };
}

export function toTransactionDto(record: TransactionRecord): Transaction {
  return {
    id: record.id,
    accountId: record.accountId,
    bookedAt: record.bookedAt,
    status: record.status,
    amount: { amountMinor: record.amountMinor, currency: record.currency },
    description: record.description,
    counterparty: record.counterparty,
    category: record.category,
    categorySource: record.categorySource,
  };
}
