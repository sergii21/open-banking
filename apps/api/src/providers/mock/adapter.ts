import type { Institution, InstitutionQuery, Permission } from '@ledger-lens/contracts';
import type { Clock } from '../../clock';
import type { PaymentUpdate } from '../../domain/payment-state';
import { redactJson } from '../../domain/redact';
import { AppError } from '../../errors';
import {
  InvalidGrantError,
  type AccountRef,
  type BankingProvider,
  type CallbackResult,
  type CallContext,
  type CompleteConnectionInput,
  type ConnectionGrant,
  type CreatedPayment,
  type CreatePaymentInput,
  type PaymentInitiation,
  type ProviderAccount,
  type ProviderBalance,
  type ProviderTransaction,
  type StartConnectionInput,
  type TokenSet,
  type TransactionWindow,
  type VerifiedWebhook,
  type WebhookRequest,
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
import {
  CreatePaymentResponseDto,
  PaymentDto,
  PaymentsTokenCache,
  PaymentsTokenDto,
  WebhookEventDto,
  mapPayment,
  mapWebhookEvent,
  throwPaymentError,
} from '../shared/payments-api';
import type { ProviderHttp } from '../transport';
import { MOCK_API_ORIGIN, MOCK_AUTH_ORIGIN } from './transport';
import {
  MOCK_INSTITUTIONS,
  findMockInstitution,
  paymentProviderId,
  paymentsNote,
  settlesPayments,
} from './institutions';
import type { DeliveryResult, MockPaymentsEngine } from './payments';
import { MOCK_SIGNATURE_HEADER, verifyMockSignature } from './signature';
import { MOCK_CLIENT_ID, MOCK_CLIENT_SECRET, type MockBankStore } from './store';

const MAX_TRANSACTION_PAGES = 40;

export interface MockProviderDeps {
  http: ProviderHttp;
  publicUrl: string;
  clock: Clock;
  store: MockBankStore;
  payments: { engine: MockPaymentsEngine; webhookSecret: string };
}

export type FailNextKind = 'unavailable' | 'rate_limit';

/** Controls the demo panel uses to reach failure states on the fake bank on demand. */
export interface MockDemoHooks {
  failNext(tokens: TokenSet, kind: FailNextKind): boolean;
  revokeAtBank(tokens: TokenSet): boolean;
  expireConsent(tokens: TokenSet, when: 'now' | 'soon'): boolean;
  /** Sends the bank's last webhook for a payment again; null when it has not sent one yet. */
  replayLastWebhook(
    providerPaymentId: string,
  ): Promise<({ type: string; eventId: string } & DeliveryResult) | null>;
}

const slugOf = (institutionId: string): string | null =>
  institutionId.startsWith('mock:') ? institutionId.slice('mock:'.length) : null;

/**
 * Adapter for the in-process fake bank. It talks to the bank over (in-process) HTTP exactly as the TrueLayer
 * adapter talks to TrueLayer, so every call shows up in the Inspector and every failure mode is a real status code.
 */
export class MockProvider implements BankingProvider, PaymentInitiation {
  readonly id = 'mock' as const;
  readonly mode = 'mock' as const;
  readonly label = 'Mock bank';

  readonly demo: MockDemoHooks;
  private readonly paymentsToken: PaymentsTokenCache;

  constructor(private readonly deps: MockProviderDeps) {
    const { store, clock } = deps;
    this.demo = {
      failNext: (tokens, kind) => {
        const consent = store.consentForAccessToken(tokens.accessToken);
        if (consent) store.setFailNext(consent.id, kind);
        return consent !== undefined;
      },
      revokeAtBank: (tokens) => {
        const consent = store.consentForAccessToken(tokens.accessToken);
        if (consent) store.revoke(consent.id);
        return consent !== undefined;
      },
      expireConsent: (tokens, when) => {
        const consent = store.consentForAccessToken(tokens.accessToken);
        if (!consent) return false;
        const at =
          when === 'now'
            ? new Date(clock.now().getTime() - 1000)
            : new Date(clock.now().getTime() + 2 * 86_400_000);
        store.setExpiry(consent.id, at.toISOString());
        return true;
      },
      replayLastWebhook: (providerPaymentId) => deps.payments.engine.replayLast(providerPaymentId),
    };
    this.paymentsToken = new PaymentsTokenCache(clock, async (ctx) => {
      const response = await deps.http.request(ctx, {
        label: 'Get payments token',
        method: 'POST',
        url: `${MOCK_AUTH_ORIGIN}/connect/token`,
        json: {
          grant_type: 'client_credentials',
          scope: 'payments',
          client_id: MOCK_CLIENT_ID,
          client_secret: MOCK_CLIENT_SECRET,
        },
      });
      if (!response.ok) {
        throw new AppError('provider_error', 502, 'The bank refused our payments credentials.');
      }
      const dto = parseDto(PaymentsTokenDto, response.body, 'payments token');
      return { token: dto.access_token, expiresInSeconds: dto.expires_in };
    });
  }

  listInstitutions(query: InstitutionQuery): Promise<Institution[]> {
    const needle = query.q?.toLowerCase();
    return Promise.resolve(
      MOCK_INSTITUTIONS.filter(
        (i) =>
          (!query.country || i.country === query.country.toUpperCase()) &&
          (!needle || i.name.toLowerCase().includes(needle)),
      ).map((i) => ({
        id: `mock:${i.slug}`,
        provider: 'mock' as const,
        mode: 'mock' as const,
        name: i.name,
        country: i.country,
        currencies: [i.currency],
        logoUrl: `/mock-bank/static/logo/${i.slug}.svg`,
        capabilities: { accounts: true, payments: true },
        health: i.healthy ? ('operational' as const) : ('degraded' as const),
        paymentsNote: paymentsNote(i),
        fixedPayee: false,
        connectMethod: 'redirect' as const,
        tokenHelp: null,
      })),
    );
  }

  startConnection(input: StartConnectionInput): Promise<{ authUrl: string }> {
    const slug = slugOf(input.institutionId);
    if (!slug || !findMockInstitution(slug)) {
      return Promise.reject(
        new AppError('provider_not_available', 404, 'That bank is not available.'),
      );
    }
    const url = new URL('/mock-bank/auth/', this.deps.publicUrl);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: MOCK_CLIENT_ID,
      redirect_uri: input.redirectUri,
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      scope: 'accounts balance transactions',
      provider: slug,
      ...(input.customerRef ? { customer_ref: input.customerRef } : {}),
    }).toString();
    return Promise.resolve({ authUrl: url.toString() });
  }

  parseCallback(query: Record<string, string | undefined>): CallbackResult {
    if (query['error']) {
      const description = `${query['error']} ${query['error_description'] ?? ''}`.toLowerCase();
      if (description.includes('timeout')) {
        return {
          kind: 'failure',
          outcome: 'timeout',
          detail: 'Strong customer authentication timed out',
        };
      }
      if (query['error'] === 'access_denied') {
        return { kind: 'failure', outcome: 'denied', detail: 'The customer denied access' };
      }
      if (query['error'] === 'temporarily_unavailable' || query['error'] === 'server_error') {
        return { kind: 'failure', outcome: 'unavailable', detail: 'The bank is unavailable' };
      }
      return { kind: 'failure', outcome: 'error', detail: String(query['error']) };
    }
    if (query['code']) return { kind: 'code', code: query['code'] };
    return {
      kind: 'failure',
      outcome: 'error',
      detail: 'The redirect carried neither a code nor an error',
    };
  }

  private async requestTokens(
    ctx: CallContext,
    label: string,
    form: Record<string, string>,
  ): Promise<TokenSet> {
    const response = await this.deps.http.request(ctx, {
      label,
      method: 'POST',
      url: `${MOCK_AUTH_ORIGIN}/connect/token`,
      form: { ...form, client_id: MOCK_CLIENT_ID, client_secret: MOCK_CLIENT_SECRET },
    });
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

  async fetchConsent(
    tokens: TokenSet,
    ctx: CallContext,
  ): Promise<{ expiresAt: string | null; permissions: Permission[] }> {
    const response = await this.deps.http.request(ctx, {
      label: 'Get consent details',
      method: 'GET',
      url: `${MOCK_API_ORIGIN}/data/v1/me`,
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
    if (!response.ok) throwDataApiError(response);
    return mapConsent(parseDto(MeDto, response.body, 'consent'));
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

  async fetchAccounts(tokens: TokenSet, ctx: CallContext): Promise<ProviderAccount[]> {
    const response = await this.deps.http.request(ctx, {
      label: 'List accounts',
      method: 'GET',
      url: `${MOCK_API_ORIGIN}/data/v1/accounts`,
      headers: { authorization: `Bearer ${tokens.accessToken}` },
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
      url: `${MOCK_API_ORIGIN}/data/v1/accounts/${encodeURIComponent(account.providerAccountId)}/balance`,
      headers: { authorization: `Bearer ${tokens.accessToken}` },
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
    const base = `${MOCK_API_ORIGIN}/data/v1/accounts/${encodeURIComponent(account.providerAccountId)}/transactions`;
    const headers = { authorization: `Bearer ${tokens.accessToken}` };
    const collected: ProviderTransaction[] = [];

    let cursor: string | null = null;
    for (let page = 0; page < MAX_TRANSACTION_PAGES; page += 1) {
      const query = new URLSearchParams({ from: window.from, to: window.to });
      if (cursor) query.set('cursor', cursor);
      const response = await this.deps.http.request(ctx, {
        label: page === 0 ? 'List transactions' : `List transactions (page ${page + 1})`,
        method: 'GET',
        url: `${base}?${query.toString()}`,
        headers,
      });
      if (!response.ok) throwDataApiError(response);
      const dto = parseDto(TransactionsDto, response.body, 'transactions');
      collected.push(...mapTransactions(dto.results, 'booked', account.providerAccountId));
      cursor = dto.next_cursor ?? null;
      if (!cursor) break;
    }

    const pending = await this.deps.http.request(ctx, {
      label: 'List pending transactions',
      method: 'GET',
      url: `${base}/pending?${new URLSearchParams({ from: window.from, to: window.to }).toString()}`,
      headers,
    });
    if (!pending.ok) throwDataApiError(pending);
    collected.push(
      ...mapTransactions(
        parseDto(TransactionsDto, pending.body, 'pending transactions').results,
        'pending',
        account.providerAccountId,
      ),
    );

    const seen = new Set<string>();
    return collected.filter((t) =>
      seen.has(t.providerTxnId) ? false : (seen.add(t.providerTxnId), true),
    );
  }

  async revoke(tokens: TokenSet, ctx: CallContext): Promise<void> {
    await this.deps.http.request(ctx, {
      label: 'Delete credentials',
      method: 'DELETE',
      url: `${MOCK_AUTH_ORIGIN}/api/delete`,
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });
  }

  // ------------------------------------------------------------------------------------ payment initiation

  fixedPayee(): null {
    return null;
  }

  /** Runs the fake bank's clock: due payment steps happen and queued webhooks are delivered. */
  tick(): Promise<void> {
    return this.deps.payments.engine.tick();
  }

  /** Runs a payments API call with the cached client-credentials token, fetching a new one once if the bank refuses it. */
  private async paymentsRequest(
    ctx: CallContext,
    request: Omit<Parameters<ProviderHttp['request']>[1], 'headers'> & {
      headers?: Record<string, string>;
    },
  ) {
    for (let attempt = 0; ; attempt += 1) {
      const token = await this.paymentsToken.get(ctx);
      const response = await this.deps.http.request(ctx, {
        ...request,
        headers: { ...request.headers, authorization: `Bearer ${token}` },
      });
      if (response.status !== 401 || attempt > 0) return response;
      this.paymentsToken.forget();
    }
  }

  async createPayment(input: CreatePaymentInput, ctx: CallContext): Promise<CreatedPayment> {
    const slug = slugOf(input.institutionId);
    const institution = slug ? findMockInstitution(slug) : undefined;
    if (!institution) {
      throw new AppError('provider_not_available', 404, 'That bank is not available.');
    }
    const { beneficiary } = input;
    if (!beneficiary) {
      throw new AppError('validation_failed', 400, 'This bank needs a payee for the payment.');
    }

    const response = await this.paymentsRequest(ctx, {
      label: 'Create payment',
      method: 'POST',
      url: `${MOCK_API_ORIGIN}/payments/v1/payments`,
      headers: { 'idempotency-key': input.idempotencyKey },
      json: {
        amount_in_minor: input.amount.amountMinor,
        currency: input.amount.currency,
        payment_method: {
          type: 'bank_transfer',
          provider_selection: {
            type: 'user_selected',
            filter: {
              countries: [institution.country],
              provider_ids: [paymentProviderId(institution)],
            },
          },
          beneficiary: {
            type: 'external_account',
            account_holder_name: beneficiary.name,
            account_identifier:
              beneficiary.type === 'iban'
                ? { type: 'iban', iban: beneficiary.iban }
                : {
                    type: 'sort_code_account_number',
                    sort_code: beneficiary.sortCode,
                    account_number: beneficiary.accountNumber,
                  },
            reference: input.reference,
          },
        },
        user: { name: 'Ledger Lens Demo' },
        hosted_page: { return_uri: input.returnUri },
        metadata: { customer_ref: input.customerRef, client_reference: input.clientReference },
      },
    });
    if (!response.ok) throwPaymentError(response);
    const dto = parseDto(CreatePaymentResponseDto, response.body, 'payment');
    if (!dto.hosted_page) {
      throw new AppError(
        'provider_error',
        502,
        'The bank did not return a page to approve the payment.',
      );
    }
    return {
      providerPaymentId: dto.id,
      authUrl: dto.hosted_page.uri,
      status: 'pending',
      settlementExpected: settlesPayments(institution),
    };
  }

  async getPayment(providerPaymentId: string, ctx: CallContext): Promise<PaymentUpdate> {
    const response = await this.paymentsRequest(ctx, {
      label: 'Get payment',
      method: 'GET',
      url: `${MOCK_API_ORIGIN}/payments/v1/payments/${encodeURIComponent(providerPaymentId)}`,
    });
    if (response.status === 404) {
      throw new AppError('not_found', 404, 'The bank does not know this payment.');
    }
    if (!response.ok) throwPaymentError(response);
    return mapPayment(
      parseDto(PaymentDto, response.body, 'payment'),
      this.deps.clock.now().toISOString(),
    );
  }

  verifyWebhook(request: WebhookRequest): Promise<VerifiedWebhook> {
    const header = request.headers[MOCK_SIGNATURE_HEADER];
    const check = verifyMockSignature(
      this.deps.payments.webhookSecret,
      Array.isArray(header) ? header[0] : header,
      request.rawBody,
      Math.floor(this.deps.clock.now().getTime() / 1000),
    );
    if (!check.ok) {
      return Promise.reject(
        new AppError(
          'invalid_webhook_signature',
          401,
          `The webhook signature did not verify (${check.reason}).`,
        ),
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(request.rawBody.toString('utf8'));
    } catch {
      return Promise.reject(
        new AppError('validation_failed', 400, 'The webhook body is not JSON.'),
      );
    }
    const parsed = WebhookEventDto.safeParse(json);
    if (!parsed.success) {
      return Promise.reject(
        new AppError('validation_failed', 400, 'The webhook body is not a known event.'),
      );
    }
    return Promise.resolve({
      eventId: parsed.data.event_id,
      type: parsed.data.type,
      providerPaymentId: parsed.data.payment_id ?? '',
      update: mapWebhookEvent(parsed.data, this.deps.clock.now().toISOString()),
      payload: redactJson(json, { maskIdentifiers: false }),
    });
  }
}
