import type { ConnectionInfo } from '@ledger-lens/contracts';
import type { ConnectionRecord } from '../../db/repos';

export function toConnectionInfo(record: ConnectionRecord): ConnectionInfo {
  const demo = record.provider === 'demo';
  return {
    id: record.id,
    provider: record.provider,
    demo,
    label: demo ? 'Demo data' : 'monobank',
    status: record.status,
    connectedAt: record.createdAt,
    lastSyncAt: record.lastRefreshedAt,
    historyMonths: record.historyMonths,
  };
}
