import type { ConnectionInfo, ProviderId } from '@ledger-lens/contracts';
import type { ConnectionRecord, SessionRecord } from '../../db/repos';
import { newId } from '../../domain/crypto';
import { AppError, notFound } from '../../errors';
import { DEMO_TOKEN } from '../../providers/monobank/demo/fake';
import type { ProviderRegistry } from '../../providers/registry';
import type { CoreContext } from '../../types';
import type { RatesService } from '../rates/service';
import type { SyncService } from '../sync/service';
import type { ConnectionAccess } from './access';
import { BANK_NAME, primaryConnection, toConnectionInfo } from './presenter';

export type ConnectInput =
  { mode: 'demo' } | { mode: 'token'; provider: 'monobank' | 'privatbank'; token: string };

export class ConnectionService {
  constructor(
    private readonly core: CoreContext,
    private readonly providers: ProviderRegistry,
    private readonly access: ConnectionAccess,
    private readonly sync: SyncService,
    private readonly rates: RatesService,
  ) {}

  list(sessionId: string): ConnectionRecord[] {
    return this.core.repos.connections.listBySession(sessionId);
  }

  infos(sessionId: string): ConnectionInfo[] {
    return this.list(sessionId).map(toConnectionInfo);
  }

  /** The connections of a session, or a 404 when there are none (the screens only exist behind a connection). */
  requireAny(sessionId: string): ConnectionRecord[] {
    const all = this.list(sessionId);
    if (all.length === 0) throw notFound('Connection');
    return all;
  }

  /**
   * Checks the token (or starts the demo) with a real call to the bank, stores it sealed, and starts loading. The same bank
   * again keeps what is already stored, so replacing a rejected token does not throw history away. A real bank replaces the
   * demo, and the demo never joins real banks: made-up money is not added to yours.
   */
  async connect(session: SessionRecord, input: ConnectInput): Promise<ConnectionRecord> {
    const providerId: ProviderId = input.mode === 'demo' ? 'demo' : input.provider;
    const before = this.list(session.id);
    if (providerId === 'demo') {
      if (before.some((c) => c.provider !== 'demo')) {
        throw new AppError(
          'conflict',
          409,
          'The demo cannot be mixed with your own banks. Disconnect them first.',
        );
      }
    } else if (!this.core.config.live) {
      throw new AppError(
        'provider_not_available',
        403,
        `A real ${BANK_NAME[providerId]} account can only be connected when the app runs on your own computer. Try the demo instead.`,
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
    if (providerId !== 'demo') {
      for (const demo of before.filter((c) => c.provider === 'demo'))
        repos.connections.delete(demo.id);
    }
    const existing = before.find((c) => c.provider === providerId);
    const keepHistory = existing !== undefined;
    let record: ConnectionRecord;
    if (existing) {
      repos.connections.update(
        existing.id,
        { tokensEnc: this.access.seal(existing.id, tokens), status: 'active' },
        now,
      );
      record = repos.connections.findById(existing.id) ?? existing;
    } else {
      const id = newId('con');
      repos.connections.insert({
        id,
        sessionId: session.id,
        provider: providerId,
        kind: 'api',
        tokensEnc: this.access.seal(id, tokens),
        historyMonths: provider.limits.historyMonths,
        now,
      });
      const created = repos.connections.findById(id);
      if (!created) throw new Error('connection was not stored');
      record = created;
    }
    this.sync.afterConnect(record, accounts, keepHistory);
    this.rates.warm(primaryConnection(this.list(session.id)) ?? record);
    this.access.notifySession(session.id);
    return repos.connections.findById(record.id) ?? record;
  }

  /** A token the bank stopped accepting, replaced by a new one for the same bank. History stays. */
  async replaceToken(
    session: SessionRecord,
    connectionId: string,
    token: string,
  ): Promise<ConnectionRecord> {
    const record = this.core.repos.connections.findForSession(session.id, connectionId);
    if (!record) throw notFound('Connection');
    if (record.kind !== 'api' || record.provider === 'demo') {
      throw new AppError('conflict', 409, 'This connection has no token to replace.');
    }
    if (record.provider !== 'monobank' && record.provider !== 'privatbank') {
      throw new AppError('conflict', 409, 'This connection has no token to replace.');
    }
    return this.connect(session, { mode: 'token', provider: record.provider, token });
  }

  /**
   * Removes one connection and everything read through it. A token stays valid at its bank until the person revokes it there;
   * monobank offers no way to do that through the API.
   */
  async disconnect(sessionId: string, connectionId: string): Promise<void> {
    const record = this.core.repos.connections.findForSession(sessionId, connectionId);
    if (!record) return;
    if (record.kind === 'api') {
      try {
        const provider = this.providers.get(record.provider);
        await provider.revoke(this.access.loadTokens(record), {
          sessionId,
          connectionId: record.id,
        });
      } catch {
        // Best effort: the local copy is deleted whatever the bank says.
      }
    }
    this.core.repos.connections.delete(record.id);
    this.core.inspector.removeConnection(sessionId, record.id, record.provider);
    this.access.notifySession(sessionId);
    this.sync.touch(sessionId);
  }

  async disconnectAll(sessionId: string): Promise<void> {
    for (const record of this.list(sessionId)) await this.disconnect(sessionId, record.id);
    this.core.inspector.clear(sessionId);
  }
}
