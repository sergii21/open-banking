import { VaultError } from '../../domain/crypto';
import { AppError } from '../../errors';
import type { ConnectionRecord, ConnectionStatus } from '../../db/repos';
import {
  TokenRejectedError,
  type BankingProvider,
  type CallContext,
  type ProviderLimits,
  type TokenSet,
} from '../../providers/port';
import type { ProviderRegistry } from '../../providers/registry';
import type { CoreContext } from '../../types';
import { toConnectionInfo } from './presenter';

/**
 * The one place that holds the bank token in memory: it unseals it, runs a provider call with it, and turns a rejected
 * token into a connection state plus the stable error code the SPA has a designed screen for. The token never leaves this
 * class except to the adapter.
 */
export class ConnectionAccess {
  constructor(
    private readonly core: CoreContext,
    private readonly providers: ProviderRegistry,
  ) {}

  seal(connectionId: string, tokens: TokenSet): string {
    return this.core.vault.seal(JSON.stringify(tokens), connectionId);
  }

  loadTokens(connection: ConnectionRecord): TokenSet {
    if (!connection.tokensEnc) {
      throw new AppError('connection_not_active', 409, 'This connection has no token.');
    }
    try {
      const parsed = JSON.parse(this.core.vault.open(connection.tokensEnc, connection.id)) as {
        accessToken?: unknown;
      };
      if (typeof parsed.accessToken !== 'string') throw new VaultError('stored token is malformed');
      return { accessToken: parsed.accessToken };
    } catch (error) {
      if (!(error instanceof VaultError)) throw error;
      // Tampered, or sealed with a key we no longer hold: the stored token is unusable, so ask for it again.
      this.core.log.error({ connectionId: connection.id }, 'stored token could not be unsealed');
      this.markStatus(connection, 'needs_reauth');
      throw new AppError('reauth_required', 401, 'Paste your monobank token again.', {
        cause: error,
      });
    }
  }

  markStatus(connection: ConnectionRecord, status: ConnectionStatus): void {
    this.core.repos.connections.update(
      connection.id,
      { status },
      this.core.clock.now().toISOString(),
    );
    this.notify(connection.id);
  }

  /** Pushes the connection's current state to the owner's open pages. */
  notify(connectionId: string): void {
    const record = this.core.repos.connections.findById(connectionId);
    if (!record) return;
    this.core.events.publish(record.sessionId, {
      type: 'connection.updated',
      connection: toConnectionInfo(record),
    });
  }

  limitsFor(connection: ConnectionRecord): ProviderLimits {
    return this.providers.get(connection.provider).limits;
  }

  assertUsable(connection: ConnectionRecord): void {
    if (connection.status === 'needs_reauth') {
      throw new AppError(
        'reauth_required',
        401,
        'monobank no longer accepts your token. Paste a new one.',
      );
    }
    if (connection.status !== 'active') {
      throw new AppError('connection_not_active', 409, 'This connection is not active.');
    }
  }

  async withTokens<T>(
    connection: ConnectionRecord,
    fn: (tokens: TokenSet, provider: BankingProvider, call: CallContext) => Promise<T>,
  ): Promise<T> {
    this.assertUsable(connection);
    const provider = this.providers.get(connection.provider);
    const call: CallContext = { sessionId: connection.sessionId, connectionId: connection.id };
    try {
      return await fn(this.loadTokens(connection), provider, call);
    } catch (error) {
      if (error instanceof TokenRejectedError) {
        this.markStatus(connection, 'needs_reauth');
        throw new AppError(
          'reauth_required',
          401,
          'monobank no longer accepts your token. Paste a new one.',
          { cause: error },
        );
      }
      throw error;
    }
  }
}
