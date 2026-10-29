import { generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import {
  InspectorCallList,
  InstitutionList,
  Payment,
  type CreatePaymentRequest,
} from '@ledger-lens/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../src/clock';
import type { TrueLayerConfig } from '../src/config';
import { EventBus } from '../src/modules/events/event-bus';
import { InspectorStore } from '../src/modules/inspector/inspector-store';
import type { CallContext, CreatePaymentInput } from '../src/providers/port';
import { TrueLayerProvider } from '../src/providers/truelayer/adapter';
import { TRUELAYER_JWKS_URL } from '../src/providers/truelayer/webhooks';
import { ProviderHttp } from '../src/providers/transport';
import { createTestApp, newClient, type Client, type TestApp } from './helpers';
import { TrueLayerStub, fixture, truelayerConfig } from './truelayer-stub';

const CTX: CallContext = { sessionId: 'ses_test', connectionId: null };
const NOW = '2026-10-28T10:00:00.000Z';
const MERCHANT_GBP = 'f3a9c1de-2b4e-4d7a-8c10-9e6b5a4d3c21';
const PAYMENT_ID = 'd9c6e3b0-4c1e-4a39-8f3e-2b7f6a1c9e55';
const WEBHOOK_PATH = '/api/webhooks/truelayer';

const p521 = () => generateKeyPairSync('ec', { namedCurve: 'secp521r1' });
const pem = (key: KeyObject): string => key.export({ type: 'pkcs8', format: 'pem' }).toString();
const b64url = (input: string | Buffer): string => Buffer.from(input).toString('base64url');

/** A key pair for the app to sign payment requests with, and one TrueLayer would sign webhooks with. */
const ours = p521();
const theirs = p521();
const OUR_KID = 'ledger-lens-sandbox-1';
const THEIR_KID = 'tl-webhook-key-1';

function config(overrides: Partial<TrueLayerConfig> = {}): TrueLayerConfig {
  return truelayerConfig({
    signing: { keyId: OUR_KID, privateKeyPem: pem(ours.privateKey) },
    beneficiary: { type: 'merchant_account', merchantAccountIds: { GBP: MERCHANT_GBP } },
    ...overrides,
  });
}

function stubbed(): TrueLayerStub {
  const stub = new TrueLayerStub();
  stub.trustSigningKey(OUR_KID, ours.publicKey);
  stub.jwks = [
    { ...theirs.publicKey.export({ format: 'jwk' }), kid: THEIR_KID, alg: 'ES512', use: 'sig' },
  ];
  return stub;
}

function adapter(cfg = config(), stub = stubbed()) {
  const clock = fixedClock(NOW);
  const inspector = new InspectorStore(new EventBus());
  const provider = new TrueLayerProvider({
    http: new ProviderHttp({
      provider: 'truelayer',
      mode: 'sandbox',
      transport: stub.transport,
      inspector,
      clock,
    }),
    config: cfg,
    clock,
    transport: stub.transport,
    webhookMaxAgeSeconds: 3600,
  });
  return { provider, stub, inspector, clock };
}

const INPUT: CreatePaymentInput = {
  clientReference: 'pay_fixture',
  institutionId: 'truelayer:mock-bank',
  amount: { amountMinor: 1234, currency: 'GBP' },
  beneficiary: null,
  reference: 'Rent',
  idempotencyKey: 'idem_0123456789abcdef',
  returnUri: 'http://localhost:4200/api/payments/return',
  customerRef: 'ignored-by-truelayer',
};

describe('creating a TrueLayer payment', () => {
  it('signs the request over the exact bytes it sends, in TrueLayer’s v2 format', async () => {
    const { provider, stub } = adapter();
    await provider.createPayment(INPUT, CTX);

    const request = stub.paymentRequests()[0];
    expect(request?.body).toBeTruthy();
    const signature = request?.headers['tl-signature'] ?? '';

    // Checked here with nothing but node:crypto, independently of the code under test.
    const [header, detachedPayload, raw] = signature.split('.');
    expect(detachedPayload).toBe('');
    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString('utf8'))).toEqual({
      alg: 'ES512',
      kid: OUR_KID,
      tl_version: '2',
      tl_headers: 'Idempotency-Key',
    });
    const signatureBytes = Buffer.from(raw ?? '', 'base64url');
    expect(signatureBytes).toHaveLength(132); // raw R||S for P-521, not a DER sequence

    const canonical = `POST /v3/payments\nIdempotency-Key: ${INPUT.idempotencyKey}\n${request?.body}`;
    expect(
      verify(
        'sha512',
        Buffer.from(`${header}.${b64url(canonical)}`),
        { key: ours.publicKey, dsaEncoding: 'ieee-p1363' },
        signatureBytes,
      ),
    ).toBe(true);
    // And the signature is only good for these bytes: change one and it no longer verifies.
    expect(
      verify(
        'sha512',
        Buffer.from(`${header}.${b64url(canonical.replace('1234', '1235'))}`),
        { key: ours.publicKey, dsaEncoding: 'ieee-p1363' },
        signatureBytes,
      ),
    ).toBe(false);
  });

  it('pays into the app’s merchant account, with a hosted-page link built from the response', async () => {
    const { provider, stub } = adapter();
    const created = await provider.createPayment(INPUT, CTX);

    const request = stub.paymentRequests()[0];
    expect(request?.headers['authorization']).toMatch(/^Bearer tl_pt_0001_fixture$/);
    expect(request?.headers['idempotency-key']).toBe(INPUT.idempotencyKey);
    expect(request?.json).toEqual({
      amount_in_minor: 1234,
      currency: 'GBP',
      payment_method: {
        type: 'bank_transfer',
        provider_selection: {
          type: 'user_selected',
          filter: { countries: ['GB'], provider_ids: ['mock-payments-gb-redirect'] },
        },
        beneficiary: {
          type: 'merchant_account',
          merchant_account_id: MERCHANT_GBP,
          reference: 'Rent',
          statement_reference: 'Rent',
        },
      },
      user: { name: 'Ledger Lens Demo', email: 'demo@ledger-lens.example' },
      hosted_page: { return_uri: INPUT.returnUri },
      metadata: { client_reference: 'pay_fixture' },
    });

    expect(created).toMatchObject({ status: 'pending', settlementExpected: true });
    const link = new URL(created.authUrl);
    expect(link.origin).toBe('https://payment.truelayer-sandbox.com');
    expect(link.pathname).toBe('/payments');
    const fragment = new URLSearchParams(link.hash.slice(1));
    expect(fragment.get('payment_id')).toBe(created.providerPaymentId);
    expect(fragment.get('resource_token')).toBe('fixture-resource-token-not-real');
    expect(fragment.get('return_uri')).toBe(INPUT.returnUri);
  });

  it('uses the hosted page link TrueLayer returns when it returns one', async () => {
    const { provider, stub } = adapter();
    stub.once('POST api.truelayer-sandbox.com/v3/payments', {
      status: 201,
      body: {
        ...fixture<object>('payments/created.json'),
        hosted_page: { uri: 'https://payment.truelayer-sandbox.com/payments#abc' },
      },
    });
    // The stub's forced reply skips its own checks, which is the point: only the response handling is under test.
    const created = await provider.createPayment(INPUT, CTX);
    expect(created.authUrl).toBe('https://payment.truelayer-sandbox.com/payments#abc');
  });

  it('pays the account the customer typed when configured for external accounts, and never settles', async () => {
    const { provider, stub } = adapter(config({ beneficiary: { type: 'external_account' } }));

    const gbp = await provider.createPayment(
      {
        ...INPUT,
        beneficiary: {
          type: 'sort_code_account_number',
          name: 'Sam Jones',
          sortCode: '112233',
          accountNumber: '12345678',
        },
      },
      CTX,
    );
    expect(gbp.settlementExpected).toBe(false);
    expect(stub.paymentRequests()[0]?.json).toMatchObject({
      payment_method: {
        beneficiary: {
          type: 'external_account',
          account_holder_name: 'Sam Jones',
          account_identifier: {
            type: 'sort_code_account_number',
            sort_code: '112233',
            account_number: '12345678',
          },
          reference: 'Rent',
        },
      },
    });

    await provider.createPayment(
      {
        ...INPUT,
        idempotencyKey: 'idem_eur_0123456789',
        amount: { amountMinor: 500, currency: 'EUR' },
        beneficiary: {
          type: 'iban',
          name: 'A very long name that goes past forty characters for sure',
          iban: 'de89 3704 0044 0532 0130 00',
        },
      },
      CTX,
    );
    expect(stub.paymentRequests()[1]?.json).toMatchObject({
      currency: 'EUR',
      payment_method: {
        provider_selection: {
          filter: { countries: ['DE'], provider_ids: ['mock-payments-de-redirect'] },
        },
        beneficiary: {
          // Normalised and cut to the length TrueLayer accepts.
          account_holder_name: 'A very long name that goes past forty ch',
          account_identifier: { type: 'iban', iban: 'DE89370400440532013000' },
        },
      },
    });
  });

  it('passes the customer’s IP along when they are present, masked in the Inspector', async () => {
    const { provider, stub, inspector } = adapter();
    await provider.createPayment(INPUT, { ...CTX, psuIp: '203.0.113.77' });
    expect(stub.paymentRequests()[0]?.headers['x-forwarded-for']).toBe('203.0.113.77');

    const call = inspector.list('ses_test').find((c) => c.label === 'Create payment');
    expect(call?.request.headers['tl-signature']).toBe('[redacted]');
    expect(call?.request.headers['authorization']).toMatch(/^Bearer ••••/);
    expect(JSON.stringify(call?.request.headers)).not.toContain('203.0.113.77');
  });

  it('keeps one payments token for several payments, and fetches another once the first is refused', async () => {
    const { provider, stub } = adapter();
    await provider.createPayment(INPUT, CTX);
    await provider.createPayment({ ...INPUT, idempotencyKey: 'idem_second_0123456' }, CTX);
    expect(stub.count('POST auth.truelayer-sandbox.com/connect/token')).toBe(1);
    expect(stub.last('POST auth.truelayer-sandbox.com/connect/token')?.json).toMatchObject({
      grant_type: 'client_credentials',
      scope: 'payments',
    });

    stub.expirePaymentsToken();
    await provider.createPayment({ ...INPUT, idempotencyKey: 'idem_third_01234567' }, CTX);
    expect(stub.count('POST auth.truelayer-sandbox.com/connect/token')).toBe(2);
    expect(stub.paymentRequests()).toHaveLength(4); // one of them was the refused attempt
  });

  it('does nothing without a signing key, or a merchant account for the currency', async () => {
    const unsigned = adapter(config({ signing: null }));
    await expect(unsigned.provider.createPayment(INPUT, CTX)).rejects.toMatchObject({
      code: 'payments_not_supported',
    });
    expect(unsigned.provider.fixedPayee('truelayer:mock-bank', 'GBP')).toBeNull();

    const noEur = adapter();
    await expect(
      noEur.provider.createPayment(
        { ...INPUT, amount: { amountMinor: 100, currency: 'EUR' } },
        CTX,
      ),
    ).rejects.toMatchObject({ code: 'payments_not_supported' });
    expect(noEur.stub.paymentRequests()).toHaveLength(0);
  });

  it('names the fixed payee without revealing the merchant account id', () => {
    const { provider } = adapter();
    expect(provider.fixedPayee('truelayer:mock-bank', 'GBP')).toEqual({
      name: 'Ledger Lens sandbox merchant account',
      identifier: 'Merchant account •••• 3c21',
    });
    expect(provider.fixedPayee('truelayer:mock-bank', 'EUR')).toBeNull();
    expect(
      adapter(config({ beneficiary: { type: 'external_account' } })).provider.fixedPayee(
        'x',
        'GBP',
      ),
    ).toBeNull();
  });
});

describe('TrueLayer payment errors', () => {
  const failWith = async (status: number, body: unknown, headers: Record<string, string> = {}) => {
    const { provider, stub } = adapter();
    stub.once('POST api.truelayer-sandbox.com/v3/payments', { status, body, headers });
    return provider.createPayment(INPUT, CTX).then(
      () => null,
      (error: unknown) => error,
    );
  };

  it('reports a refused request as a rejected payment, with the field that was wrong', async () => {
    expect(await failWith(400, fixture('payments/errors/invalid-parameters.json'))).toMatchObject({
      code: 'payment_rejected',
      status: 422,
      message: expect.stringContaining(
        'payment_method.beneficiary.reference: must be at most 18 characters',
      ),
    });
  });

  it('tells the operator when the credentials or the signature are not accepted', async () => {
    const { provider, stub } = adapter();
    stub.once('POST api.truelayer-sandbox.com/v3/payments', {
      status: 401,
      body: fixture('payments/errors/unauthorized.json'),
    });
    stub.once('POST api.truelayer-sandbox.com/v3/payments', {
      status: 401,
      body: fixture('payments/errors/unauthorized.json'),
    });
    await expect(provider.createPayment(INPUT, CTX)).rejects.toMatchObject({
      code: 'provider_error',
      status: 502,
      message: expect.stringContaining('signing key id'),
    });
    // It tried once more with a new token before giving up.
    expect(stub.count('POST auth.truelayer-sandbox.com/connect/token')).toBe(2);
  });

  it('separates "still being processed" from "same key, different request"', async () => {
    expect(
      await failWith(409, fixture('payments/errors/idempotency-in-flight.json')),
    ).toMatchObject({
      code: 'conflict',
      status: 409,
    });
    expect(await failWith(422, fixture('payments/errors/idempotency-conflict.json'))).toMatchObject(
      {
        code: 'idempotency_conflict',
        status: 422,
      },
    );
  });

  it('maps rate limits and outages, and keeps the retry hint', async () => {
    expect(
      await failWith(429, { title: 'Too Many Requests' }, { 'retry-after': '12' }),
    ).toMatchObject({
      code: 'rate_limited',
      retryAfterSeconds: 12,
    });
    expect(await failWith(503, { title: 'Service Unavailable' })).toMatchObject({
      code: 'bank_unavailable',
      status: 503,
    });
    expect(await failWith(500, 'not even json')).toMatchObject({ code: 'bank_unavailable' });
  });

  it('treats an unreadable success response as a provider error rather than inventing a payment', async () => {
    const { provider, stub } = adapter();
    stub.once('POST api.truelayer-sandbox.com/v3/payments', { status: 201, body: { nope: true } });
    await expect(provider.createPayment(INPUT, CTX)).rejects.toMatchObject({
      code: 'provider_error',
    });
  });
});

describe('reading a TrueLayer payment', () => {
  const read = async (fixtureName: string) => {
    const { provider, stub } = adapter();
    stub.setPayment(PAYMENT_ID, fixtureName);
    // The payments token comes from the same stub; ask once to get one issued.
    await provider.createPayment(INPUT, CTX);
    stub.setPayment(PAYMENT_ID, fixtureName);
    return provider.getPayment(PAYMENT_ID, CTX);
  };

  it.each([
    ['payments/authorization-required.json', 'pending', null],
    ['payments/authorized.json', 'authorised', null],
    ['payments/executed.json', 'executed', null],
    ['payments/settled.json', 'settled', null],
    ['payments/failed-canceled.json', 'cancelled', 'cancelled'],
    ['payments/failed-insufficient-funds.json', 'failed', 'insufficient_funds'],
  ] as const)('maps %s to %s', async (name, status, failureReason) => {
    expect(await read(name)).toMatchObject({ status, failureReason });
  });

  it('takes the time from the payment, and falls back to now when it has none', async () => {
    expect((await read('payments/executed.json')).at).toBe('2026-10-28T10:00:09.000Z');
    const { provider, stub } = adapter();
    await provider.createPayment(INPUT, CTX);
    stub.setPayment(PAYMENT_ID, 'payments/authorized.json', { authorized_at: undefined });
    expect((await provider.getPayment(PAYMENT_ID, CTX)).at).toBe(NOW);
  });

  it('maps failure reasons by what they mean to the customer, and by stage when there is no reason', async () => {
    const reasons: [string | null, string | null, string, string][] = [
      ['authorization_failed', 'authorizing', 'failed', 'authorisation_failed'],
      ['invalid_credentials', 'authorizing', 'failed', 'authorisation_failed'],
      ['expired', 'authorization_required', 'failed', 'expired'],
      ['user_canceled_at_provider', 'authorizing', 'cancelled', 'cancelled'],
      ['provider_error', 'authorized', 'failed', 'provider_error'],
      ['payment_limit_exceeded', 'authorized', 'failed', 'execution_rejected'],
      ['blocked', 'authorized', 'failed', 'execution_rejected'],
      [null, 'authorizing', 'failed', 'authorisation_failed'],
      [null, 'authorized', 'failed', 'execution_rejected'],
      [null, null, 'failed', 'provider_error'],
    ];
    for (const [reason, stage, status, failureReason] of reasons) {
      const { provider, stub } = adapter();
      await provider.createPayment(INPUT, CTX);
      stub.setPayment(PAYMENT_ID, 'payments/failed-canceled.json', {
        failure_reason: reason,
        failure_stage: stage,
      });
      expect(await provider.getPayment(PAYMENT_ID, CTX), `${reason} @ ${stage}`).toMatchObject({
        status,
        failureReason,
      });
    }
  });

  it('refuses a status it does not know instead of guessing, and says so for a missing payment', async () => {
    const { provider, stub } = adapter();
    await provider.createPayment(INPUT, CTX);
    stub.setPayment(PAYMENT_ID, 'payments/executed.json', { status: 'teleported' });
    await expect(provider.getPayment(PAYMENT_ID, CTX)).rejects.toMatchObject({
      code: 'provider_error',
    });
    await expect(provider.getPayment('no-such-payment', CTX)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

// ================================================================================================ the whole app

let t: TestApp;
let opened = false;
afterEach(closeApp);

async function closeApp(): Promise<void> {
  if (!opened) return;
  opened = false;
  await t.close();
}

const GBP: CreatePaymentRequest = {
  institutionId: 'truelayer:mock-bank',
  amountMinor: 1234,
  currency: 'GBP',
  reference: 'Rent',
};

async function app(cfg = config(), stub = stubbed()) {
  opened = true;
  t = await createTestApp(
    { providers: { mock: { enabled: true }, truelayer: cfg, monobank: null } },
    NOW,
    { truelayer: stub.transport },
  );
  const client = await newClient(t);
  return { client, stub };
}

async function paymentFor(client: Client, stub: TrueLayerStub) {
  const response = await client.createPayment(GBP);
  expect(response.statusCode).toBe(201);
  const payment = Payment.parse(response.json());
  const providerId = t.ctx.repos.payments.findById(payment.id)?.providerPaymentId as string;
  stub.setPayment(providerId, 'payments/authorization-required.json');
  return { payment, providerId };
}

describe('TrueLayer payments through the app', () => {
  it('offers payments only when signing is set up, to a fixed payee', async () => {
    const { client } = await app();
    const list = InstitutionList.parse((await client.get('/api/institutions?q=TrueLayer')).json());
    expect(list.items[0]).toMatchObject({
      id: 'truelayer:mock-bank',
      capabilities: { payments: true },
      fixedPayee: true,
      currencies: ['GBP'],
    });
    await closeApp();

    const { client: unsigned } = await app(config({ signing: null }));
    const none = InstitutionList.parse(
      (await unsigned.get('/api/institutions?q=TrueLayer')).json(),
    );
    expect(none.items[0]?.capabilities.payments).toBe(false);
    const refused = await unsigned.createPayment(GBP);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ code: 'payments_not_supported' });
  });

  it('creates the payment, ignoring the payee typed on the form, and hides the resource token at rest', async () => {
    const { client, stub } = await app();
    const response = await client.createPayment({
      ...GBP,
      beneficiary: {
        type: 'sort_code_account_number',
        name: 'Somebody Else',
        sortCode: '998877',
        accountNumber: '87654321',
      },
    });
    expect(response.statusCode).toBe(201);
    const payment = Payment.parse(response.json());

    expect(payment).toMatchObject({
      provider: 'truelayer',
      mode: 'sandbox',
      beneficiaryName: 'Ledger Lens sandbox merchant account',
      settlementExpected: true,
      status: 'pending',
    });
    expect(JSON.stringify(stub.paymentRequests()[0]?.json)).not.toContain('Somebody Else');
    expect(JSON.stringify(t.db.all('SELECT * FROM payments'))).not.toContain(
      'fixture-resource-token',
    );
    expect(new URL(payment.authUrl as string).hash).toContain('resource_token=');
  });

  it('applies a webhook signed by TrueLayer, once', async () => {
    const { client, stub } = await app();
    const { payment, providerId } = await paymentFor(client, stub);

    const executed = fixture<object>('payments/webhooks/payment-executed.json');
    const first = await deliver({ ...executed, payment_id: providerId });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ status: 'applied' });
    expect(Payment.parse((await client.get(`/api/payments/${payment.id}`)).json()).status).toBe(
      'executed',
    );

    const again = await deliver({ ...executed, payment_id: providerId });
    expect(again.json()).toEqual({ status: 'duplicate' });

    const calls = InspectorCallList.parse((await client.get('/api/inspector/calls')).json()).items;
    expect(calls.find((c) => c.direction === 'inbound')).toMatchObject({
      label: 'Webhook: payment_executed',
      provider: 'truelayer',
      url: WEBHOOK_PATH,
    });
    expect(calls.find((c) => c.direction === 'inbound')?.request.headers['tl-signature']).toBe(
      '[redacted]',
    );
  });

  it('turns a failure event into the failed state the customer sees', async () => {
    const { client, stub } = await app();
    const { payment, providerId } = await paymentFor(client, stub);
    await deliver({
      ...fixture<object>('payments/webhooks/payment-failed.json'),
      payment_id: providerId,
    });
    expect(Payment.parse((await client.get(`/api/payments/${payment.id}`)).json())).toMatchObject({
      status: 'cancelled',
      failureReason: 'cancelled',
    });
  });

  it('ignores event types it does not act on', async () => {
    const { client, stub } = await app();
    const { providerId } = await paymentFor(client, stub);
    const response = await deliver({
      type: 'payment_creditable',
      event_id: 'evt_creditable_1',
      payment_id: providerId,
    });
    expect(response.json()).toEqual({ status: 'unsupported_event' });
  });

  it('catches up by polling when no webhook arrives, and when the customer returns', async () => {
    const { client, stub } = await app();
    const { payment, providerId } = await paymentFor(client, stub);

    stub.setPayment(providerId, 'payments/executed.json');
    t.clock.advance(25_000);
    await t.ctx.payments.pollDue();
    expect(Payment.parse((await client.get(`/api/payments/${payment.id}`)).json()).status).toBe(
      'executed',
    );

    stub.setPayment(providerId, 'payments/settled.json');
    const back = await client.get(`/api/payments/return?payment_id=${providerId}`);
    expect(back.headers['location']).toBe(`/payments/${payment.id}/result`);
    expect(Payment.parse((await client.get(`/api/payments/${payment.id}`)).json()).status).toBe(
      'settled',
    );

    const abandoned = await client.get(
      `/api/payments/return?payment_id=${providerId}&error=tl_hpp_abandoned`,
    );
    expect(abandoned.headers['location']).toBe(`/payments/${payment.id}/result?abandoned=1`);
  });

  it('survives TrueLayer being down when the customer comes back', async () => {
    const { client, stub } = await app();
    const { payment, providerId } = await paymentFor(client, stub);
    stub.once('GET api.truelayer-sandbox.com/v3/payments/', { status: 503, body: {} });
    const back = await client.get(`/api/payments/return?payment_id=${providerId}`);
    expect(back.statusCode).toBe(302);
    expect(back.headers['location']).toBe(`/payments/${payment.id}/result`);
    expect(Payment.parse((await client.get(`/api/payments/${payment.id}`)).json()).status).toBe(
      'pending',
    );
  });

  // ------------------------------------------------------------------------------------ verification

  function deliver(
    body: object | string,
    options: Parameters<typeof signedWebhook>[1] = {},
    path = WEBHOOK_PATH,
  ) {
    const { raw, headers } = signedWebhook(body, options);
    return t.app.inject({ method: 'POST', url: path, headers, payload: raw });
  }

  /** Signs a webhook the way TrueLayer does, with the key set published at the jku. */
  function signedWebhook(
    body: object | string,
    options: {
      key?: KeyObject;
      kid?: string;
      alg?: string;
      jku?: string;
      path?: string;
      timestamp?: string;
      /** Header values to send that differ from the ones that were signed. */
      sendInstead?: Record<string, string>;
      signedBody?: string;
      omitSignature?: boolean;
    } = {},
  ) {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const timestamp = options.timestamp ?? t.clock.now().toISOString();
    const signedHeaders: [string, string][] = [
      ['X-Tl-Webhook-Timestamp', timestamp],
      ['Content-Type', 'application/json'],
    ];
    const header = {
      alg: options.alg ?? 'ES512',
      kid: options.kid ?? THEIR_KID,
      tl_version: '2',
      tl_headers: signedHeaders.map(([name]) => name).join(','),
      jku: options.jku ?? TRUELAYER_JWKS_URL,
    };
    const encodedHeader = b64url(JSON.stringify(header));
    const canonical = [
      `POST ${options.path ?? WEBHOOK_PATH}`,
      ...signedHeaders.map(([name, value]) => `${name}: ${value}`),
      options.signedBody ?? raw,
    ].join('\n');
    const signature = sign('sha512', Buffer.from(`${encodedHeader}.${b64url(canonical)}`), {
      key: options.key ?? theirs.privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    return {
      raw,
      headers: {
        'content-type': 'application/json',
        'x-tl-webhook-timestamp': timestamp,
        ...(options.omitSignature
          ? {}
          : { 'tl-signature': `${encodedHeader}..${b64url(signature)}` }),
        ...options.sendInstead,
      },
    };
  }

  it('rejects anything that is not signed by TrueLayer’s key, and changes nothing', async () => {
    const { client, stub } = await app();
    const { payment, providerId } = await paymentFor(client, stub);
    const event = {
      ...fixture<object>('payments/webhooks/payment-executed.json'),
      payment_id: providerId,
    };

    const attempts = {
      'no signature header': await deliver(event, { omitSignature: true }),
      'signed with someone else’s key': await deliver(event, { key: p521().privateKey }),
      'signed for a different body': await deliver(event, { signedBody: '{"other":"body"}' }),
      'signed for a different path': await deliver(event, { path: '/api/webhooks/other' }),
      'a signed header was changed in transit': await deliver(event, {
        sendInstead: { 'x-tl-webhook-timestamp': '2026-10-28T09:59:59.000Z' },
      }),
      'unknown key id': await deliver(event, { kid: 'not-a-key' }),
      'a weaker algorithm': await deliver(event, { alg: 'HS256' }),
      'no algorithm at all': await deliver(event, { alg: 'none' }),
      'garbage in the header': await deliver(event, {
        sendInstead: { 'tl-signature': 'a.b.c.d' },
      }),
    };
    for (const [why, response] of Object.entries(attempts)) {
      expect(response.statusCode, why).toBe(401);
      expect(response.json(), why).toMatchObject({ code: 'invalid_webhook_signature' });
    }
    expect(Payment.parse((await client.get(`/api/payments/${payment.id}`)).json()).status).toBe(
      'pending',
    );
    expect(t.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM webhook_events')?.n).toBe(0);
  });

  it('never fetches keys from a place the sender names', async () => {
    const { client, stub } = await app();
    const { providerId } = await paymentFor(client, stub);
    const before = stub.count('webhooks.truelayer-sandbox.com');
    const response = await deliver(
      { ...fixture<object>('payments/webhooks/payment-executed.json'), payment_id: providerId },
      { jku: 'https://evil.example/.well-known/jwks' },
    );
    expect(response.statusCode).toBe(401);
    expect(stub.count('evil.example')).toBe(0);
    expect(stub.count('webhooks.truelayer-sandbox.com')).toBe(before);
  });

  it('rejects a genuine signature that is too old, or from the future', async () => {
    const { client, stub } = await app();
    const { providerId } = await paymentFor(client, stub);
    const event = {
      ...fixture<object>('payments/webhooks/payment-executed.json'),
      payment_id: providerId,
    };
    expect((await deliver(event, { timestamp: '2026-10-24T10:00:00.000Z' })).statusCode).toBe(401);
    expect((await deliver(event, { timestamp: '2026-10-28T12:00:00.000Z' })).statusCode).toBe(401);
    expect((await deliver(event, { timestamp: 'yesterday-ish' })).statusCode).toBe(401);
    // Within the window (retries of an older event are normal) it is accepted.
    expect((await deliver(event, { timestamp: '2026-10-28T09:30:00.000Z' })).statusCode).toBe(200);
  });

  it('accepts a path that differs from the signed one only by a trailing slash', async () => {
    const { client, stub } = await app();
    const { providerId } = await paymentFor(client, stub);
    const event = {
      ...fixture<object>('payments/webhooks/payment-executed.json'),
      payment_id: providerId,
    };
    const response = await deliver(event, { path: `${WEBHOOK_PATH}/` });
    expect(response.statusCode).toBe(200);
  });

  it('caches the key set, refetches it when TrueLayer rotates keys, and not more often than that', async () => {
    const { client, stub } = await app();
    const { providerId } = await paymentFor(client, stub);
    const event = {
      ...fixture<object>('payments/webhooks/payment-authorized.json'),
      payment_id: providerId,
    };

    await deliver(event);
    await deliver({ ...event, event_id: 'evt_2' });
    expect(stub.count('GET webhooks.truelayer-sandbox.com/.well-known/jwks')).toBe(1);

    const rotated = p521();
    stub.jwks = [
      ...stub.jwks,
      { ...rotated.publicKey.export({ format: 'jwk' }), kid: 'tl-webhook-key-2', alg: 'ES512' },
    ];
    // An unknown key id right after a fetch does not trigger another one: that would let anyone hammer TrueLayer through us.
    expect(
      (
        await deliver(
          { ...event, event_id: 'evt_3' },
          { kid: 'tl-webhook-key-2', key: rotated.privateKey },
        )
      ).statusCode,
    ).toBe(401);
    expect(stub.count('GET webhooks.truelayer-sandbox.com/.well-known/jwks')).toBe(1);

    t.clock.advance(61_000);
    expect(
      (
        await deliver(
          { ...event, event_id: 'evt_4' },
          {
            kid: 'tl-webhook-key-2',
            key: rotated.privateKey,
            timestamp: t.clock.now().toISOString(),
          },
        )
      ).statusCode,
    ).toBe(200);
    expect(stub.count('GET webhooks.truelayer-sandbox.com/.well-known/jwks')).toBe(2);
  });

  it('answers 5xx, so TrueLayer retries, when it cannot fetch the keys', async () => {
    const { client, stub } = await app();
    const { payment, providerId } = await paymentFor(client, stub);
    stub.once('GET webhooks.truelayer-sandbox.com', { status: 503, body: {} });
    const event = {
      ...fixture<object>('payments/webhooks/payment-executed.json'),
      payment_id: providerId,
    };
    const failed = await deliver(event);
    expect(failed.statusCode).toBe(502);

    const retried = await deliver(event);
    expect(retried.statusCode).toBe(200);
    expect(Payment.parse((await client.get(`/api/payments/${payment.id}`)).json()).status).toBe(
      'executed',
    );
  });
});
