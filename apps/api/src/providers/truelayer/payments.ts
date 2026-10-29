import type { Clock } from '../../clock';
import type { PaymentCurrency, TrueLayerConfig } from '../../config';
import { redactJson } from '../../domain/redact';
import type { PaymentUpdate } from '../../domain/payment-state';
import { AppError } from '../../errors';
import type {
  CallContext,
  CreatedPayment,
  CreatePaymentInput,
  PaymentInitiation,
  VerifiedWebhook,
  WebhookRequest,
} from '../port';
import { parseDto } from '../shared/data-api';
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
import type { HttpResult, ProviderHttp, Transport } from '../transport';
import { signRequest } from './signing';
import { TRUELAYER_API_ORIGIN, TRUELAYER_AUTH_ORIGIN, TRUELAYER_PAYMENT_PAGE_ORIGIN } from './urls';
import { WebhookVerifier } from './webhooks';

export interface TrueLayerPaymentsDeps {
  http: ProviderHttp;
  config: TrueLayerConfig;
  clock: Clock;
  /** For fetching TrueLayer's public webhook keys, which is not a call made on anyone's behalf. */
  transport: Transport;
  webhookMaxAgeSeconds: number;
}

const PAYMENTS_PATH = '/v3/payments';

const isCurrency = (currency: string): currency is PaymentCurrency =>
  currency === 'GBP' || currency === 'EUR';

/** Mock providers are named for their country (`mock-payments-gb-redirect`); fall back to the currency's home market. */
function countryOf(providerId: string, currency: PaymentCurrency): string {
  const match = /^mock-payments-([a-z]{2})-/.exec(providerId);
  return match?.[1]?.toUpperCase() ?? (currency === 'GBP' ? 'GB' : 'DE');
}

/**
 * The link to TrueLayer's hosted payment page, built from what the create call returned. The resource token in the
 * fragment authorises that one payment page and lasts about fifteen minutes.
 */
export function hostedPaymentLink(
  paymentId: string,
  resourceToken: string,
  returnUri: string,
): string {
  const fragment = [
    `payment_id=${encodeURIComponent(paymentId)}`,
    `resource_token=${encodeURIComponent(resourceToken)}`,
    `return_uri=${encodeURIComponent(returnUri)}`,
  ].join('&');
  return `${TRUELAYER_PAYMENT_PAGE_ORIGIN}/payments#${fragment}`;
}

/**
 * TrueLayer Payments v3 (sandbox): create a payment with a signed request, send the customer to the hosted payment
 * page, and follow the payment by webhook with polling as the fallback.
 *
 * The beneficiary is either one of the app's merchant accounts (the default: a sandbox app has these out of the box, the
 * payee the customer typed is not used, and such payments settle) or the account the customer typed (an external
 * account; it needs that entitlement on the TrueLayer app and ends at "executed").
 */
export class TrueLayerPayments implements PaymentInitiation {
  private readonly tokens: PaymentsTokenCache;
  private readonly verifier: WebhookVerifier;

  constructor(private readonly deps: TrueLayerPaymentsDeps) {
    this.verifier = new WebhookVerifier(deps.transport, deps.clock, deps.webhookMaxAgeSeconds);
    this.tokens = new PaymentsTokenCache(deps.clock, async (ctx) => {
      const { clientId, clientSecret } = deps.config;
      const response = await deps.http.request(ctx, {
        label: 'Get payments token',
        method: 'POST',
        url: `${TRUELAYER_AUTH_ORIGIN}/connect/token`,
        json: {
          grant_type: 'client_credentials',
          scope: 'payments',
          client_id: clientId,
          client_secret: clientSecret,
        },
      });
      if (!response.ok) {
        throw new AppError(
          'provider_error',
          502,
          'TrueLayer refused this app’s credentials for payments. Check the client id and secret, and that the app has the payments scope.',
        );
      }
      const dto = parseDto(PaymentsTokenDto, response.body, 'payments token');
      return { token: dto.access_token, expiresInSeconds: dto.expires_in };
    });
  }

  fixedPayee(
    _institutionId: string,
    currency: string,
  ): { name: string; identifier: string } | null {
    const { beneficiary, signing } = this.deps.config;
    if (!signing || beneficiary.type !== 'merchant_account' || !isCurrency(currency)) return null;
    const id = beneficiary.merchantAccountIds[currency];
    return id
      ? {
          name: 'Ledger Lens sandbox merchant account',
          identifier: `Merchant account •••• ${id.slice(-4)}`,
        }
      : null;
  }

  /** Runs a payments call with the cached token, getting a new one once if TrueLayer says the old one is no good. */
  private async request(
    ctx: CallContext,
    spec: Omit<Parameters<ProviderHttp['request']>[1], 'headers'> & {
      headers?: Record<string, string>;
    },
  ): Promise<HttpResult> {
    for (let attempt = 0; ; attempt += 1) {
      const token = await this.tokens.get(ctx);
      const response = await this.deps.http.request(ctx, {
        ...spec,
        headers: { ...spec.headers, authorization: `Bearer ${token}` },
      });
      if (response.status !== 401 || attempt > 0) return response;
      this.tokens.forget();
    }
  }

  private beneficiary(input: CreatePaymentInput, currency: PaymentCurrency): unknown {
    const { beneficiary } = this.deps.config;
    if (beneficiary.type === 'merchant_account') {
      const merchantAccountId = beneficiary.merchantAccountIds[currency];
      if (!merchantAccountId) {
        throw new AppError(
          'payments_not_supported',
          400,
          `No TrueLayer merchant account is configured for ${currency}.`,
        );
      }
      return {
        type: 'merchant_account',
        merchant_account_id: merchantAccountId,
        reference: input.reference,
        statement_reference: input.reference.slice(0, 18),
      };
    }
    const payee = input.beneficiary;
    if (!payee) throw new AppError('validation_failed', 400, 'Enter who you are paying.');
    return {
      type: 'external_account',
      account_holder_name: payee.name.slice(0, 40),
      account_identifier:
        payee.type === 'iban'
          ? { type: 'iban', iban: payee.iban.replaceAll(' ', '').toUpperCase() }
          : {
              type: 'sort_code_account_number',
              sort_code: payee.sortCode,
              account_number: payee.accountNumber,
            },
      reference: input.reference,
    };
  }

  async createPayment(input: CreatePaymentInput, ctx: CallContext): Promise<CreatedPayment> {
    const { config } = this.deps;
    const currency = input.amount.currency;
    if (!config.signing || !isCurrency(currency)) {
      throw new AppError('payments_not_supported', 400, 'TrueLayer payments are not set up here.');
    }
    const signing = config.signing;
    const providerId = config.paymentProviders[currency];

    const response = await this.request(ctx, {
      label: 'Create payment',
      method: 'POST',
      url: `${TRUELAYER_API_ORIGIN}${PAYMENTS_PATH}`,
      headers: {
        'idempotency-key': input.idempotencyKey,
        ...(ctx.psuIp ? { 'x-forwarded-for': ctx.psuIp } : {}),
      },
      json: {
        amount_in_minor: input.amount.amountMinor,
        currency,
        payment_method: {
          type: 'bank_transfer',
          provider_selection: {
            type: 'user_selected',
            filter: {
              countries: [countryOf(providerId, currency)],
              provider_ids: [providerId],
            },
          },
          beneficiary: this.beneficiary(input, currency),
        },
        user: { name: 'Ledger Lens Demo', email: config.userEmail },
        hosted_page: { return_uri: input.returnUri },
        metadata: { client_reference: input.clientReference },
      },
      // The signature covers the exact bytes sent, which only the transport layer knows once it has serialised the body.
      sign: (body) => ({
        'tl-signature': signRequest(signing, {
          method: 'POST',
          path: PAYMENTS_PATH,
          headers: [['Idempotency-Key', input.idempotencyKey]],
          body,
        }),
      }),
    });
    if (!response.ok) throwPaymentError(response);

    const dto = parseDto(CreatePaymentResponseDto, response.body, 'payment');
    return {
      providerPaymentId: dto.id,
      authUrl:
        dto.hosted_page?.uri ?? hostedPaymentLink(dto.id, dto.resource_token, input.returnUri),
      status: 'pending',
      settlementExpected: config.beneficiary.type === 'merchant_account',
    };
  }

  async getPayment(providerPaymentId: string, ctx: CallContext): Promise<PaymentUpdate> {
    const response = await this.request(ctx, {
      label: 'Get payment',
      method: 'GET',
      url: `${TRUELAYER_API_ORIGIN}${PAYMENTS_PATH}/${encodeURIComponent(providerPaymentId)}`,
    });
    if (response.status === 404) {
      throw new AppError('not_found', 404, 'TrueLayer does not know this payment.');
    }
    if (!response.ok) throwPaymentError(response);
    return mapPayment(
      parseDto(PaymentDto, response.body, 'payment'),
      this.deps.clock.now().toISOString(),
    );
  }

  async verifyWebhook(request: WebhookRequest): Promise<VerifiedWebhook> {
    await this.verifier.verify(request);

    let json: unknown;
    try {
      json = JSON.parse(request.rawBody.toString('utf8'));
    } catch {
      throw new AppError('validation_failed', 400, 'The webhook body is not JSON.');
    }
    const parsed = WebhookEventDto.safeParse(json);
    if (!parsed.success) {
      throw new AppError('validation_failed', 400, 'The webhook body is not a known event.');
    }
    return {
      eventId: parsed.data.event_id,
      type: parsed.data.type,
      providerPaymentId: parsed.data.payment_id ?? '',
      update: mapWebhookEvent(parsed.data, this.deps.clock.now().toISOString()),
      payload: redactJson(json, { maskIdentifiers: false }),
    };
  }
}
