import type { Institution, InstitutionQuery, Permission } from '@ledger-lens/contracts';
import type { Clock } from '../../clock';
import type { TrueLayerConfig } from '../../config';
import { AppError } from '../../errors';
import {
  InvalidGrantError,
  type AccountRef,
  type BankingProvider,
  type CallbackResult,
  type CallContext,
  type CompleteConnectionInput,
  type ConnectionGrant,
  type ProviderAccount,
  type ProviderBalance,
  type ProviderTransaction,
  type StartConnectionInput,
  type TokenSet,
  type TransactionWindow,
} from '../port';
import {
  AccountsDto,
  BalanceDto,
  MeDto,
  OAuthTokenDto,
  TransactionsDto,
  mapAccounts,
  mapBalance,
  mapConsent,
  mapTransactions,
  parseDto,
  throwDataApiError,
  throwTokenError,
} from '../shared/data-api';
import type { ProviderHttp } from '../transport';
import { TRUELAYER_INSTITUTION_ID, truelayerInstitutions } from './institutions';
import { TRUELAYER_API_ORIGIN, TRUELAYER_AUTH_ORIGIN, TRUELAYER_DATA_SCOPES } from './urls';

export interface TrueLayerDeps {
  http: ProviderHttp;
  config: TrueLayerConfig;
  clock: Clock;
}

/** Errors on the redirect back that mean "the bank was not reachable" rather than "the customer said no". */
const UNAVAILABLE_ERRORS = new Set([
  'temporarily_unavailable',
  'server_error',
  'provider_error',
  'connector_overloaded',
  'internal_server_error',
]);

/**
 * TrueLayer Data API adapter (sandbox). Account information only here; payments are layered on in `payments.ts`.
 * The customer signs in on TrueLayer's hosted auth dialog and at their bank, we get an authorisation code on our
 * redirect URI and swap it for tokens server-side with PKCE.
 */
export class TrueLayerProvider implements BankingProvider {
  readonly id = 'truelayer' as const;
  readonly mode = 'sandbox' as const;
  readonly label = 'TrueLayer sandbox';

  constructor(protected readonly deps: TrueLayerDeps) {}

  get config(): TrueLayerConfig {
    return this.deps.config;
  }

  listInstitutions(query: InstitutionQuery): Promise<Institution[]> {
    return Promise.resolve(truelayerInstitutions(this.deps.config, query));
  }

  startConnection(input: StartConnectionInput): Promise<{ authUrl: string }> {
    if (input.institutionId !== TRUELAYER_INSTITUTION_ID) {
      return Promise.reject(
        new AppError('provider_not_available', 404, 'That bank is not available.'),
      );
    }
    const url = new URL(TRUELAYER_AUTH_ORIGIN);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.deps.config.clientId,
      scope: TRUELAYER_DATA_SCOPES,
      redirect_uri: input.redirectUri,
      providers: this.deps.config.dataProviders,
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return Promise.resolve({ authUrl: url.toString() });
  }

  parseCallback(query: Record<string, string | undefined>): CallbackResult {
    const error = query['error'];
    if (error) {
      const text = `${error} ${query['error_description'] ?? ''}`.toLowerCase();
      if (text.includes('timeout') || text.includes('timed out') || text.includes('expired')) {
        return {
          kind: 'failure',
          outcome: 'timeout',
          detail: 'Strong customer authentication timed out',
        };
      }
      if (error === 'access_denied' || error === 'user_cancelled' || error === 'consent_denied') {
        return { kind: 'failure', outcome: 'denied', detail: 'The customer did not give access' };
      }
      if (UNAVAILABLE_ERRORS.has(error)) {
        return { kind: 'failure', outcome: 'unavailable', detail: 'The bank is unavailable' };
      }
      return { kind: 'failure', outcome: 'error', detail: error };
    }
    if (query['code']) return { kind: 'code', code: query['code'] };
    return {
      kind: 'failure',
      outcome: 'error',
      detail: 'The redirect carried neither a code nor an error',
    };
  }

  /** The Data API identifies the customer's browser, not our server, so user-driven calls pass the customer's IP. */
  protected dataHeaders(tokens: TokenSet, ctx: CallContext): Record<string, string> {
    return {
      authorization: `Bearer ${tokens.accessToken}`,
      ...(ctx.psuIp ? { 'x-psu-ip': ctx.psuIp } : {}),
    };
  }

  private async requestTokens(
    ctx: CallContext,
    label: string,
    body: Record<string, string>,
  ): Promise<TokenSet> {
    const { clientId, clientSecret } = this.deps.config;
    const response = await this.deps.http.request(ctx, {
      label,
      method: 'POST',
      url: `${TRUELAYER_AUTH_ORIGIN}/connect/token`,
      json: { ...body, client_id: clientId, client_secret: clientSecret },
    });
    if (response.status === 401 || (response.status === 400 && isInvalidClient(response.body))) {
      // Our own credentials are wrong: an operator problem, not something the customer can fix by signing in again.
      throw new AppError(
        'provider_error',
        502,
        'TrueLayer rejected this app’s credentials. Check TRUELAYER_CLIENT_ID and TRUELAYER_CLIENT_SECRET.',
      );
    }
    if (!response.ok) throwTokenError(response);
    const dto = parseDto(OAuthTokenDto, response.body, 'token');
    return {
      accessToken: dto.access_token,
      refreshToken: dto.refresh_token ?? null,
      expiresAt: new Date(this.deps.clock.now().getTime() + dto.expires_in * 1000).toISOString(),
      scope: dto.scope ?? null,
    };
  }

  async completeConnection(
    input: CompleteConnectionInput,
    ctx: CallContext,
  ): Promise<ConnectionGrant> {
    let tokens: TokenSet;
    try {
      tokens = await this.requestTokens(ctx, 'Exchange authorisation code', {
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier,
      });
    } catch (error) {
      if (error instanceof InvalidGrantError) {
        throw new AppError(
          'invalid_state',
          400,
          'The authorisation code was rejected. Start again.',
        );
      }
      throw error;
    }
    const consent = await this.fetchConsent(tokens, ctx);
    return { tokens, consentExpiresAt: consent.expiresAt, permissions: consent.permissions };
  }

  refreshTokens(tokens: TokenSet, ctx: CallContext): Promise<TokenSet> {
    if (!tokens.refreshToken) {
      return Promise.reject(new InvalidGrantError('No refresh token is held'));
    }
    return this.requestTokens(ctx, 'Refresh access token', {
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
    });
  }

  async fetchConsent(
    tokens: TokenSet,
    ctx: CallContext,
  ): Promise<{ expiresAt: string | null; permissions: Permission[] }> {
    const response = await this.deps.http.request(ctx, {
      label: 'Get consent details',
      method: 'GET',
      url: `${TRUELAYER_API_ORIGIN}/data/v1/me`,
      headers: this.dataHeaders(tokens, ctx),
    });
    if (!response.ok) throwDataApiError(response);
    return mapConsent(parseDto(MeDto, response.body, 'consent'));
  }

  async fetchAccounts(tokens: TokenSet, ctx: CallContext): Promise<ProviderAccount[]> {
    const response = await this.deps.http.request(ctx, {
      label: 'List accounts',
      method: 'GET',
      url: `${TRUELAYER_API_ORIGIN}/data/v1/accounts`,
      headers: this.dataHeaders(tokens, ctx),
    });
    if (!response.ok) throwDataApiError(response);
    const accounts = mapAccounts(parseDto(AccountsDto, response.body, 'accounts'));
    const result: ProviderAccount[] = [];
    for (const account of accounts) {
      const balance = await this.fetchBalance(
        tokens,
        { providerAccountId: account.providerAccountId, currency: account.currency },
        ctx,
      );
      result.push({ ...account, ...balance });
    }
    return result;
  }

  async fetchBalance(
    tokens: TokenSet,
    account: AccountRef,
    ctx: CallContext,
  ): Promise<ProviderBalance> {
    const response = await this.deps.http.request(ctx, {
      label: 'Get balance',
      method: 'GET',
      url: `${TRUELAYER_API_ORIGIN}/data/v1/accounts/${encodeURIComponent(account.providerAccountId)}/balance`,
      headers: this.dataHeaders(tokens, ctx),
    });
    if (!response.ok) throwDataApiError(response);
    return mapBalance(parseDto(BalanceDto, response.body, 'balance'));
  }

  async fetchTransactions(
    tokens: TokenSet,
    account: AccountRef,
    window: TransactionWindow,
    ctx: CallContext,
  ): Promise<ProviderTransaction[]> {
    const base = `${TRUELAYER_API_ORIGIN}/data/v1/accounts/${encodeURIComponent(account.providerAccountId)}/transactions`;
    const headers = this.dataHeaders(tokens, ctx);
    const query = new URLSearchParams({ from: window.from, to: window.to }).toString();

    // TrueLayer returns the whole window in one response; there is no cursor to follow.
    const booked = await this.deps.http.request(ctx, {
      label: 'List transactions',
      method: 'GET',
      url: `${base}?${query}`,
      headers,
    });
    if (!booked.ok) throwDataApiError(booked);
    const rows = mapTransactions(
      parseDto(TransactionsDto, booked.body, 'transactions').results,
      'booked',
      account.providerAccountId,
    );

    const pending = await this.deps.http.request(ctx, {
      label: 'List pending transactions',
      method: 'GET',
      url: `${base}/pending`,
      headers,
    });
    // Not every bank reports pending items; TrueLayer answers 501 for those, which just means "none".
    if (pending.status !== 501) {
      if (!pending.ok) throwDataApiError(pending);
      rows.push(
        ...mapTransactions(
          parseDto(TransactionsDto, pending.body, 'pending transactions').results,
          'pending',
          account.providerAccountId,
        ),
      );
    }

    const seen = new Set<string>();
    return rows.filter((t) =>
      seen.has(t.providerTxnId) ? false : (seen.add(t.providerTxnId), true),
    );
  }

  async revoke(tokens: TokenSet, ctx: CallContext): Promise<void> {
    await this.deps.http.request(ctx, {
      label: 'Delete credentials',
      method: 'DELETE',
      url: `${TRUELAYER_AUTH_ORIGIN}/api/delete`,
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
  }
}

const isInvalidClient = (body: unknown): boolean =>
  (body as { error?: string } | undefined)?.error === 'invalid_client';
