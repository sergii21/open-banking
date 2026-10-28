import type {
  Connection,
  CreateConnectionRequest,
  CreateConnectionResponse,
} from '@ledger-lens/contracts';
import type { ConnectionRecord } from '../../db/repos';
import { createPkce, newId, randomToken } from '../../domain/crypto';
import { AppError, notFound } from '../../errors';
import type { CallContext } from '../../providers/port';
import type { ProviderRegistry } from '../../providers/registry';
import type { CoreContext } from '../../types';
import type { SyncService } from '../sync/service';
import type { ConnectionAccess } from './access';
import { toConnectionDto } from './presenter';

/** A consent redirect that is not completed within this window is abandoned. */
const STATE_TTL_MS = 15 * 60_000;

/**
 * Consent lifecycle: start a bank redirect, finish it, list and revoke connections. The redirect target is
 * `/api/connections/callback`, and the pending row is found by `state`, not by cookie: some banks return through a
 * cross-site POST, where a SameSite=Lax cookie would not be sent.
 */
export class ConnectionService {
  constructor(
    private readonly core: CoreContext,
    private readonly providers: ProviderRegistry,
    private readonly access: ConnectionAccess,
    private readonly sync: SyncService,
  ) {}

  private get redirectUri(): string {
    return `${this.core.config.publicUrl}/api/connections/callback`;
  }

  get(sessionId: string, id: string): ConnectionRecord {
    const connection = this.core.repos.connections.findForSession(sessionId, id);
    if (!connection) throw notFound('Connection');
    return connection;
  }

  /** Marks active connections whose consent end has passed, then returns the session's connections. */
  list(sessionId: string): Connection[] {
    const records = this.core.repos.connections.listBySession(sessionId);
    const now = this.core.clock.now().getTime();
    return records.map((record) => {
      const expired =
        record.status === 'active' &&
        record.consentExpiresAt !== null &&
        Date.parse(record.consentExpiresAt) <= now;
      const current = expired ? this.access.markStatus(record, 'expired') : record;
      return toConnectionDto(this.core, current);
    });
  }

  async start(
    sessionId: string,
    request: CreateConnectionRequest,
  ): Promise<CreateConnectionResponse> {
    const { provider } = this.providers.resolveInstitution(request.institutionId);
    const call: CallContext = { sessionId, connectionId: null };

    const institutions = await provider.listInstitutions({}, call);
    const institution = institutions.find((i) => i.id === request.institutionId);
    if (!institution)
      throw new AppError('provider_not_available', 404, 'That bank is not available.');
    if (!institution.capabilities.accounts) {
      throw new AppError(
        'provider_not_available',
        400,
        'That bank does not support account information.',
      );
    }

    const now = this.core.clock.now();
    this.core.repos.connections.deleteAbandoned(sessionId, now.toISOString());

    const state = randomToken(32);
    const { verifier, challenge } = createPkce();
    const stateExpiresAt = new Date(now.getTime() + STATE_TTL_MS).toISOString();

    let connectionId: string;
    if (request.reconnectConnectionId) {
      const existing = this.get(sessionId, request.reconnectConnectionId);
      if (existing.institutionId !== request.institutionId) {
        throw new AppError('validation_failed', 400, 'Reconnect must use the same bank.');
      }
      connectionId = existing.id;
      this.core.repos.connections.update(
        existing.id,
        {
          state,
          stateExpiresAt,
          codeVerifierEnc: this.core.vault.seal(verifier, existing.id),
        },
        now.toISOString(),
      );
    } else {
      connectionId = newId('con');
      this.core.repos.connections.insertPending({
        id: connectionId,
        sessionId,
        provider: provider.id,
        institutionId: institution.id,
        institutionName: institution.name,
        institutionLogoUrl: institution.logoUrl,
        state,
        stateExpiresAt,
        codeVerifierEnc: this.core.vault.seal(verifier, connectionId),
        now: now.toISOString(),
      });
    }

    const { authUrl } = await provider.startConnection(
      {
        institutionId: institution.id,
        state,
        codeChallenge: challenge,
        redirectUri: this.redirectUri,
      },
      { sessionId, connectionId },
    );
    return { connectionId, authUrl };
  }

  /** Drops a failed attempt: a brand-new connection disappears, a reconnect keeps its previous state. */
  private abandon(connection: ConnectionRecord): void {
    if (connection.tokensEnc) {
      this.core.repos.connections.update(
        connection.id,
        { state: null, stateExpiresAt: null, codeVerifierEnc: null },
        this.core.clock.now().toISOString(),
      );
    } else {
      this.core.repos.connections.delete(connection.id);
    }
  }

  /** Finishes the bank redirect and returns where the browser should go next (a SPA path). */
  async complete(query: Record<string, string | undefined>, psuIp?: string): Promise<string> {
    const resultUrl = (status: string, extra: Record<string, string> = {}): string =>
      `/connect/result?${new URLSearchParams({ status, ...extra }).toString()}`;

    const state = query['state'];
    const connection = state ? this.core.repos.connections.findByState(state) : undefined;
    if (
      !connection?.stateExpiresAt ||
      connection.stateExpiresAt < this.core.clock.now().toISOString()
    ) {
      return resultUrl('invalid_state');
    }

    const provider = this.providers.get(connection.provider);
    const callback = provider.parseCallback(query);
    if (callback.kind === 'failure') {
      this.core.log.info(
        { outcome: callback.outcome, provider: provider.id },
        'consent did not complete',
      );
      this.abandon(connection);
      return resultUrl(callback.outcome);
    }

    const call: CallContext = {
      sessionId: connection.sessionId,
      connectionId: connection.id,
      ...(psuIp ? { psuIp } : {}),
    };
    const now = this.core.clock.now().toISOString();
    try {
      if (!connection.codeVerifierEnc) throw new AppError('invalid_state', 400);
      const grant = await provider.completeConnection(
        {
          code: callback.code,
          codeVerifier: this.core.vault.open(connection.codeVerifierEnc, connection.id),
          redirectUri: this.redirectUri,
        },
        call,
      );
      this.core.repos.connections.update(
        connection.id,
        {
          status: 'active',
          tokensEnc: this.access.sealTokens(connection.id, grant.tokens),
          tokenExpiresAt: grant.tokens.expiresAt,
          permissions: grant.permissions,
          consentExpiresAt: grant.consentExpiresAt,
          state: null,
          stateExpiresAt: null,
          codeVerifierEnc: null,
        },
        now,
      );
      const active = this.get(connection.sessionId, connection.id);
      await this.sync.initialSync(active, psuIp);
      this.access.notify(connection.id);
      return resultUrl('success', { connection: connection.id });
    } catch (error) {
      this.core.log.warn(
        { provider: provider.id, code: error instanceof AppError ? error.code : 'unexpected' },
        'finishing the connection failed',
      );
      await this.discardFailedConnection(connection.id);
      if (error instanceof AppError) {
        if (error.code === 'bank_unavailable' || error.code === 'rate_limited')
          return resultUrl('unavailable');
        if (error.code === 'invalid_state') return resultUrl('invalid_state');
      }
      return resultUrl('error');
    }
  }

  /** After a failed finish: release the bank-side credentials and forget a connection that never became usable. */
  private async discardFailedConnection(connectionId: string): Promise<void> {
    const record = this.core.repos.connections.findById(connectionId);
    if (!record) return;
    const hadAccounts = this.core.repos.connections.accountCount(connectionId) > 0;
    if (record.tokensEnc && !hadAccounts) {
      await this.revokeAtProvider(record);
      this.core.repos.connections.delete(connectionId);
    } else {
      this.abandon(record);
    }
  }

  private async revokeAtProvider(connection: ConnectionRecord): Promise<void> {
    if (!connection.tokensEnc || !this.providers.has(connection.provider)) return;
    try {
      const provider = this.providers.get(connection.provider);
      await provider.revoke(this.access.loadTokens(connection), {
        sessionId: connection.sessionId,
        connectionId: connection.id,
      });
    } catch (error) {
      // Revocation at the bank is best effort; the local data is deleted regardless.
      this.core.log.warn(
        { provider: connection.provider, err: error instanceof Error ? error.name : 'unknown' },
        'revoke at provider failed',
      );
    }
  }

  /** Withdraws consent at the bank (best effort) and deletes every cached account and transaction. */
  async revoke(sessionId: string, connectionId: string): Promise<void> {
    const connection = this.get(sessionId, connectionId);
    await this.revokeAtProvider(connection);
    this.core.repos.connections.delete(connection.id);
  }

  async revokeAll(sessionId: string): Promise<void> {
    for (const connection of this.core.repos.connections.listBySession(sessionId)) {
      await this.revokeAtProvider(connection);
    }
  }
}
