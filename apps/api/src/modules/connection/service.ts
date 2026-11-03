import { newId } from '../../domain/crypto';
import { AppError, notFound } from '../../errors';
import type { SessionRecord, ConnectionRecord } from '../../db/repos';
import { DEMO_TOKEN } from '../../providers/monobank/demo/fake';
import type { ProviderRegistry } from '../../providers/registry';
import type { CoreContext } from '../../types';
import type { RatesService } from '../rates/service';
import type { SyncService } from '../sync/service';
import type { ConnectionAccess } from './access';
import { toConnectionInfo } from './presenter';

export type ConnectInput = { mode: 'demo' } | { mode: 'token'; token: string };

export class ConnectionService {
  constructor(
    private readonly core: CoreContext,
    private readonly providers: ProviderRegistry,
    private readonly access: ConnectionAccess,
    private readonly sync: SyncService,
    private readonly rates: RatesService,
  ) {}

  current(sessionId: string): ConnectionRecord | undefined {
    return this.core.repos.connections.findBySession(sessionId);
  }

  info(sessionId: string) {
    const record = this.current(sessionId);
    return record ? toConnectionInfo(record) : null;
  }

  /**
   * Checks the token (or starts the demo) with a real call to the bank, stores it sealed, and starts loading. The same
   * provider again keeps what is already stored, so replacing a rejected token does not throw history away.
   */
  async connect(session: SessionRecord, input: ConnectInput): Promise<ConnectionRecord> {
    const providerId = input.mode === 'demo' ? 'demo' : 'monobank';
    if (providerId === 'monobank' && !this.core.config.live) {
      throw new AppError(
        'provider_not_available',
        403,
        'A real monobank account can only be connected when the app runs on your own computer. Try the demo instead.',
      );
    }
    const provider = this.providers.get(providerId);
    const token = input.mode === 'demo' ? DEMO_TOKEN : input.token;
    const { tokens, accounts } = await provider.connect(
      { token },
      { sessionId: session.id, connectionId: null },
    );

    const { repos, clock } = this.core;
    const now = clock.now().toISOString();
    const existing = repos.connections.findBySession(session.id);
    const keepHistory = existing?.provider === providerId;
    let record: ConnectionRecord;
    if (existing && keepHistory) {
      repos.connections.update(
        existing.id,
        { tokensEnc: this.access.seal(existing.id, tokens), status: 'active' },
        now,
      );
      record = repos.connections.findById(existing.id) ?? existing;
    } else {
      if (existing) repos.connections.delete(existing.id);
      const id = newId('con');
      repos.connections.insert({
        id,
        sessionId: session.id,
        provider: providerId,
        tokensEnc: this.access.seal(id, tokens),
        historyMonths: provider.limits.historyMonths,
        now,
      });
      const created = repos.connections.findById(id);
      if (!created) throw new Error('connection was not stored');
      record = created;
    }
    this.sync.afterConnect(record, accounts, keepHistory);
    this.rates.warm(record);
    this.access.notify(record.id);
    return repos.connections.findById(record.id) ?? record;
  }

  /** Removes the connection and everything read through it. The token stays valid at monobank until a new one is issued there. */
  async disconnect(sessionId: string): Promise<void> {
    const record = this.current(sessionId);
    if (!record) return;
    try {
      const provider = this.providers.get(record.provider);
      await provider.revoke(this.access.loadTokens(record), { sessionId, connectionId: record.id });
    } catch {
      // Best effort: the local copy is deleted whatever the bank says.
    }
    this.core.repos.connections.delete(record.id);
    this.core.inspector.clear(sessionId);
    this.core.events.publish(sessionId, { type: 'connection.updated', connection: null });
  }

  requireCurrent(sessionId: string): ConnectionRecord {
    const record = this.current(sessionId);
    if (!record) throw notFound('Connection');
    return record;
  }
}
