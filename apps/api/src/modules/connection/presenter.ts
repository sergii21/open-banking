import type { BankId, ConnectionInfo, ProviderId } from '@ledger-lens/contracts';
import type { ConnectionRecord } from '../../db/repos';

/** The bank an account belongs to. The demo is a made-up monobank. */
export const BANK_OF: Readonly<Record<ProviderId, BankId>> = {
  monobank: 'monobank',
  demo: 'monobank',
  privatbank: 'privatbank',
  privat24: 'privatbank',
  wise: 'wise',
};

/** What a connection is called in lists. */
export const LABEL_OF: Readonly<Record<ProviderId, string>> = {
  monobank: 'monobank',
  demo: 'Demo data',
  privatbank: 'PrivatBank business',
  privat24: 'Privat24 statement',
  wise: 'Wise',
};

/** What the person calls the bank inside a sentence ("PrivatBank no longer accepts your token"). */
export const BANK_NAME: Readonly<Record<ProviderId, string>> = {
  monobank: 'monobank',
  demo: 'The demo bank',
  privatbank: 'PrivatBank',
  privat24: 'Privat24',
  wise: 'Wise',
};

export function toConnectionInfo(record: ConnectionRecord): ConnectionInfo {
  return {
    id: record.id,
    provider: record.provider,
    kind: record.kind,
    bank: BANK_OF[record.provider],
    demo: record.provider === 'demo',
    label: LABEL_OF[record.provider],
    status: record.status,
    connectedAt: record.createdAt,
    lastSyncAt: record.lastRefreshedAt,
    historyMonths: record.kind === 'file' ? 0 : record.historyMonths,
  };
}

/**
 * The connection a session-wide call is filed under (rates, in the Live API drawer): a bank read through a token if there is
 * one, otherwise whatever is connected.
 */
export function primaryConnection(
  connections: readonly ConnectionRecord[],
): ConnectionRecord | undefined {
  return connections.find((c) => c.kind === 'api') ?? connections[0];
}
