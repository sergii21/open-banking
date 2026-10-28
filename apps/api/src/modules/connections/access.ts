import * as z from 'zod';
import type { ConnectionStatus } from '@ledger-lens/contracts';
import type { ConnectionRecord } from '../../db/repos';
import { hasConsentExpired } from '../../domain/consent';
import { VaultError } from '../../domain/crypto';
import { AppError } from '../../errors';
import {
  ConsentGoneError,
  InvalidGrantError,
  TokenRejectedError,
  type BankingProvider,
  type CallContext,
  type TokenSet,
} from '../../providers/port';
import type { ProviderRegistry } from '../../providers/registry';
import type { CoreContext } from '../../types';
import { toConnectionDto } from './presenter';

const StoredTokens = z.object({
  accessToken: z.string(),
  refreshToken: z.string().nullable(),
  expiresAt: z.string(),
  scope: z.string().nullable(),
});

/** Refresh when the access token has less than this left, so a call never starts with a token about to die. */
const REFRESH_MARGIN_MS = 60_000;

/**
 * The one place that holds provider tokens in memory: it unseals them, keeps them fresh (single-flight, so a burst of
 * calls triggers one refresh), runs a provider call with them, and turns provider failures into connection state
 * changes plus the stable error codes the SPA has designed states for. Tokens never leave this class except to the adapter.
 */
export class ConnectionAccess {
  private readonly inflightRefresh = new Map<string, Promise<TokenSet>>();

  constructor(
    private readonly core: CoreContext,
    private readonly providers: ProviderRegistry,
  ) {}

  // ----------------------------------------------------------------------------------- token storage

  sealTokens(connectionId: string, tokens: TokenSet): string {
    return this.core.vault.seal(JSON.stringify(tokens), connectionId);
  }

  loadTokens(connection: ConnectionRecord): TokenSet {
    if (!connection.tokensEnc)
      throw new AppError('connection_not_active', 409, 'This connection has no credentials.');
    try {
      return StoredTokens.parse(
        JSON.parse(this.core.vault.open(connection.tokensEnc, connection.id)),
      );
    } catch (error) {
      if (!(error instanceof VaultError)) throw error;
      // Tampered, or sealed with a key we no longer hold: the stored credentials are unusable, so ask for a fresh consent.
      this.core.log.error(
        { connectionId: connection.id },
        'stored credentials could not be unsealed',
      );
      this.markStatus(connection, 'needs_reauth');
      throw new AppError('reauth_required', 401, 'Your bank needs you to sign in again.', {
        cause: error,
      });
    }
  }

  private saveTokens(connectionId: string, tokens: TokenSet): void {
    this.core.repos.connections.update(
      connectionId,
      { tokensEnc: this.sealTokens(connectionId, tokens), tokenExpiresAt: tokens.expiresAt },
      this.core.clock.now().toISOString(),
    );
  }

  // ----------------------------------------------------------------------------------- state machine

  markStatus(connection: ConnectionRecord, status: ConnectionStatus): ConnectionRecord {
    const now = this.core.clock.now().toISOString();
    this.core.repos.connections.update(connection.id, { status }, now);
    const updated = this.core.repos.connections.findById(connection.id) ?? {
      ...connection,
      status,
    };
    this.core.events.publish(connection.sessionId, {
      type: 'connection.updated',
      connection: toConnectionDto(this.core, updated),
    });
    return updated;
  }

  /** Pushes the connection's current state to the owner's open pages. */
  notify(connectionId: string): void {
    const record = this.core.repos.connections.findById(connectionId);
    if (!record) return;
    this.core.events.publish(record.sessionId, {
      type: 'connection.updated',
      connection: toConnectionDto(this.core, record),
    });
  }

  /** Throws the right error when a connection cannot be used for provider calls right now. */
  assertUsable(connection: ConnectionRecord): void {
    switch (connection.status) {
      case 'active':
        if (hasConsentExpired(connection.consentExpiresAt, this.core.clock.now())) {
          this.markStatus(connection, 'expired');
          throw new AppError(
            'consent_expired',
            403,
            'The bank consent has expired. Reconnect to continue.',
          );
        }
        return;
      case 'expired':
        throw new AppError(
          'consent_expired',
          403,
          'The bank consent has expired. Reconnect to continue.',
        );
      case 'revoked':
        throw new AppError(
          'consent_revoked',
          403,
          'The consent was revoked. Reconnect to continue.',
        );
      case 'needs_reauth':
        throw new AppError('reauth_required', 401, 'Your bank needs you to sign in again.');
      default:
        throw new AppError('connection_not_active', 409, 'This connection is not active.');
    }
  }

  private translate(connection: ConnectionRecord, error: unknown): unknown {
    if (error instanceof TokenRejectedError || error instanceof InvalidGrantError) {
      this.markStatus(connection, 'needs_reauth');
      return new AppError('reauth_required', 401, 'Your bank needs you to sign in again.', {
        cause: error,
      });
    }
    if (error instanceof ConsentGoneError) {
      this.markStatus(connection, error.reason === 'revoked' ? 'revoked' : 'expired');
      return error.reason === 'revoked'
        ? new AppError(
            'consent_revoked',
            403,
            'The consent was revoked at the bank. Reconnect to continue.',
            { cause: error },
          )
        : new AppError(
            'consent_expired',
            403,
            'The bank consent has expired. Reconnect to continue.',
            { cause: error },
          );
    }
    return error;
  }

  // ----------------------------------------------------------------------------------- refresh

  private refresh(
    connection: ConnectionRecord,
    provider: BankingProvider,
    call: CallContext,
    staleAccessToken: string,
  ): Promise<TokenSet> {
    const existing = this.inflightRefresh.get(connection.id);
    if (existing) return existing;

    const run = (async (): Promise<TokenSet> => {
      // Another request may already have refreshed while we were waiting: reuse that result.
      const latest = this.core.repos.connections.findById(connection.id);
      if (latest?.tokensEnc) {
        const stored = this.loadTokens(latest);
        if (stored.accessToken !== staleAccessToken) return stored;
      }
      const next = await provider.refreshTokens(this.loadTokens(latest ?? connection), call);
      this.saveTokens(connection.id, next);
      return next;
    })().finally(() => {
      this.inflightRefresh.delete(connection.id);
    });

    this.inflightRefresh.set(connection.id, run);
    return run;
  }

  // ----------------------------------------------------------------------------------- the entry point

  /**
   * Runs `fn` with valid tokens. A rejected access token is refreshed once and the call retried; if the bank still
   * says no, the connection moves to `needs_reauth`.
   */
  async withTokens<T>(
    connection: ConnectionRecord,
    fn: (tokens: TokenSet, provider: BankingProvider, call: CallContext) => Promise<T>,
    options: { psuIp?: string | undefined } = {},
  ): Promise<T> {
    this.assertUsable(connection);
    const provider = this.providers.get(connection.provider);
    const call: CallContext = {
      sessionId: connection.sessionId,
      connectionId: connection.id,
      ...(options.psuIp ? { psuIp: options.psuIp } : {}),
    };

    try {
      let tokens = this.loadTokens(connection);
      if (Date.parse(tokens.expiresAt) - this.core.clock.now().getTime() < REFRESH_MARGIN_MS) {
        tokens = await this.refresh(connection, provider, call, tokens.accessToken);
      }
      try {
        return await fn(tokens, provider, call);
      } catch (error) {
        if (!(error instanceof TokenRejectedError)) throw error;
        tokens = await this.refresh(connection, provider, call, tokens.accessToken);
        return await fn(tokens, provider, call);
      }
    } catch (error) {
      throw this.translate(connection, error);
    }
  }
}
