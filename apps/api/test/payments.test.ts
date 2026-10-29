import {
  AccountList,
  InspectorCallList,
  Payment,
  PaymentList,
  TransactionPage,
  type CreatePaymentRequest,
} from '@ledger-lens/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/errors';
import { mockWebhookSecret, signMockWebhook } from '../src/providers/mock/signature';
import { createTestApp, newClient, type Client, type TestApp } from './helpers';

let t: TestApp;
afterEach(async () => {
  await t.close();
});

const EUR: CreatePaymentRequest = {
  institutionId: 'mock:mock-bank',
  amountMinor: 1234,
  currency: 'EUR',
  beneficiary: { type: 'iban', name: 'Erika Mustermann', iban: 'DE89370400440532013000' },
  reference: 'Rent',
};
const GBP: CreatePaymentRequest = {
  institutionId: 'mock:mock-bank-uk',
  amountMinor: 2500,
  currency: 'GBP',
  beneficiary: {
    type: 'sort_code_account_number',
    name: 'Sam Jones',
    sortCode: '112233',
    accountNumber: '12345678',
  },
  reference: 'Lunch',
};

async function setup(
  overrides = {},
): Promise<{ client: Client; tick(seconds: number): Promise<void> }> {
  t = await createTestApp({ mockBankStepSeconds: 3, ...overrides });
  const client = await newClient(t);
  const mock = t.ctx.providers.mock();
  if (!mock) throw new Error('the mock bank is not enabled');
  return {
    client,
    /** Moves time forward and lets the fake bank do whatever has come due, including sending webhooks. */
    tick: async (seconds) => {
      t.clock.advance(seconds * 1000);
      await mock.tick();
    },
  };
}

async function create(client: Client, body: CreatePaymentRequest = EUR): Promise<Payment> {
  const response = await client.createPayment(body);
  expect(response.statusCode).toBe(201);
  return Payment.parse(response.json());
}

const fetchPayment = async (client: Client, id: string): Promise<Payment> =>
  Payment.parse((await client.get(`/api/payments/${id}`)).json());

const statuses = (payment: Payment): string[] => payment.statusHistory.map((h) => h.status);

describe('creating a payment', () => {
  it('registers the payment with the bank and returns the page where the customer approves it', async () => {
    const { client } = await setup();
    const payment = await create(client);

    expect(payment).toMatchObject({
      provider: 'mock',
      mode: 'mock',
      status: 'pending',
      amount: { amountMinor: 1234, currency: 'EUR' },
      beneficiaryName: 'Erika Mustermann',
      reference: 'Rent',
      settlementExpected: true,
      failureReason: null,
    });
    // Only a masked identifier is ever stored or shown.
    expect(payment.beneficiaryIdentifier).toBe('DE•• •••• •••• 3000');
    expect(payment.authUrl).toMatch(/\/mock-bank\/pay\?payment_id=mpay_.+&resource_token=mbk_pay_/);

    const list = PaymentList.parse((await client.get('/api/payments')).json());
    expect(list.items.map((p) => p.id)).toEqual([payment.id]);
  });

  it('seals the bank link at rest and stops exposing it once the customer has moved on', async () => {
    const { client, tick } = await setup();
    const payment = await create(client);

    const stored = t.ctx.repos.payments.findById(payment.id);
    expect(stored?.authUrlEnc).toBeTruthy();
    expect(stored?.authUrlEnc).not.toContain('resource_token');
    expect(JSON.stringify(t.db.all('SELECT * FROM payments'))).not.toContain('mbk_pay_');

    await client.payAtBank(payment.authUrl as string);
    await tick(4);
    const after = await fetchPayment(client, payment.id);
    expect(after.status).toBe('executed');
    expect(after.authUrl).toBeNull();
    expect(t.ctx.repos.payments.findById(payment.id)?.authUrlEnc).toBeNull();
  });

  it('validates on the server: currency, size, and the payee that suits the currency', async () => {
    const { client } = await setup();

    const wrongCurrency = await client.createPayment({ ...EUR, currency: 'GBP' });
    expect(wrongCurrency.statusCode).toBe(400);
    expect(wrongCurrency.json()).toMatchObject({
      code: 'validation_failed',
      errors: [{ path: 'currency' }],
    });

    const tooMuch = await client.createPayment({ ...EUR, amountMinor: 500_001 });
    expect(tooMuch.statusCode).toBe(400);
    expect(tooMuch.json()).toMatchObject({ errors: [{ path: 'amountMinor' }] });

    const noPayee = await client.createPayment({ ...EUR, beneficiary: undefined });
    expect(noPayee.statusCode).toBe(400);
    expect(noPayee.json()).toMatchObject({ errors: [{ path: 'beneficiary' }] });

    const wrongPayee = await client.createPayment({ ...EUR, beneficiary: GBP.beneficiary });
    expect(wrongPayee.statusCode).toBe(400);
    expect(wrongPayee.json()).toMatchObject({ errors: [{ path: 'beneficiary' }] });

    const badIban = await client.createPayment({
      ...EUR,
      beneficiary: { type: 'iban', name: 'X', iban: 'DE00000000000000000000' },
    });
    expect(badIban.statusCode).toBe(400);

    const unknownBank = await client.createPayment({ ...EUR, institutionId: 'mock:nope' });
    expect(unknownBank.statusCode).toBe(400);
    expect(unknownBank.json()).toMatchObject({ code: 'payments_not_supported' });

    const noProvider = await client.createPayment({ ...EUR, institutionId: 'truelayer:mock-bank' });
    expect(noProvider.statusCode).toBe(404);
    expect(noProvider.json()).toMatchObject({ code: 'provider_not_available' });

    expect(PaymentList.parse((await client.get('/api/payments')).json()).items).toEqual([]);
  });

  it('needs a session and the XSRF token like any other write', async () => {
    t = await createTestApp();
    const anonymous = await t.app.inject({
      method: 'POST',
      url: '/api/payments',
      headers: { 'idempotency-key': 'abcdefgh-1234' },
      payload: EUR,
    });
    expect(anonymous.statusCode).toBe(401);

    const client = await newClient(t);
    const noXsrf = await client.post('/api/payments', EUR, {
      csrf: false,
      headers: { 'idempotency-key': 'abcdefgh-1234' },
    });
    expect(noXsrf.statusCode).toBe(403);
  });
});

describe('idempotency', () => {
  it('requires an Idempotency-Key', async () => {
    const { client } = await setup();
    const missing = await client.createPayment(EUR, null);
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ code: 'idempotency_key_required' });

    const malformed = await client.createPayment(EUR, 'no');
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: 'validation_failed' });
  });

  it('replays the first answer for the same key and request, without a second payment', async () => {
    const { client } = await setup();
    const key = 'retry-after-a-double-click';
    const first = await client.createPayment(EUR, key);
    const second = await client.createPayment(EUR, key);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
    expect(PaymentList.parse((await client.get('/api/payments')).json()).items).toHaveLength(1);
    expect(t.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM mock_payments')?.n).toBe(1);
  });

  it('treats a reformatted but identical IBAN as the same request', async () => {
    const { client } = await setup();
    const key = 'same-payee-spaced-out';
    await client.createPayment(EUR, key);
    const again = await client.createPayment(
      {
        ...EUR,
        beneficiary: {
          type: 'iban',
          name: ' Erika Mustermann ',
          iban: 'de89 3704 0044 0532 0130 00',
        },
      },
      key,
    );
    expect(again.statusCode).toBe(200);
  });

  it('refuses the same key with a different request', async () => {
    const { client } = await setup();
    const key = 'one-key-two-payments';
    await client.createPayment(EUR, key);
    const other = await client.createPayment({ ...EUR, amountMinor: 9999 }, key);

    expect(other.statusCode).toBe(422);
    expect(other.json()).toMatchObject({ code: 'idempotency_conflict' });
    expect(t.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM mock_payments')?.n).toBe(1);
  });

  it('scopes keys to the session, so one customer cannot replay or collide with another', async () => {
    const { client } = await setup();
    const other = await newClient(t);
    const key = 'shared-looking-key';
    const mine = await create(client);
    await client.createPayment(EUR, key);
    const theirs = await other.createPayment({ ...EUR, amountMinor: 5 }, key);
    expect(theirs.statusCode).toBe(201);

    expect((await other.get(`/api/payments/${mine.id}`)).statusCode).toBe(404);
    expect(PaymentList.parse((await other.get('/api/payments')).json()).items).toHaveLength(1);
  });

  it('keeps an attempt whose outcome is unknown, so retrying with the same key completes the same payment', async () => {
    const { client } = await setup();
    const mock = t.ctx.providers.mock();
    if (!mock) throw new Error('mock bank missing');
    const real = mock.createPayment.bind(mock);

    // The bank accepted the payment, but its answer never reached us.
    const spy = vi.spyOn(mock, 'createPayment').mockImplementationOnce(async (input, ctx) => {
      await real(input, ctx);
      throw new AppError('bank_unavailable', 503, 'The bank did not answer in time.');
    });

    const key = 'lost-response-key-1';
    const first = await client.createPayment(EUR, key);
    expect(first.statusCode).toBe(503);
    expect(first.json()).toMatchObject({ code: 'bank_unavailable' });
    // Nothing the customer can see yet: an attempt only becomes a payment once the bank has acknowledged it.
    expect(PaymentList.parse((await client.get('/api/payments')).json()).items).toEqual([]);
    expect(t.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM payments')?.n).toBe(1);

    const retry = await client.createPayment(EUR, key);
    expect(retry.statusCode).toBe(201);
    expect(spy).toHaveBeenCalledTimes(2);
    // The provider saw the same idempotency key twice and paid once.
    expect(t.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM mock_payments')?.n).toBe(1);
    expect(PaymentList.parse((await client.get('/api/payments')).json()).items).toHaveLength(1);
  });

  it('forgets an attempt the bank refused outright, so the key can be used again', async () => {
    const { client } = await setup();
    const mock = t.ctx.providers.mock();
    if (!mock) throw new Error('mock bank missing');
    vi.spyOn(mock, 'createPayment').mockRejectedValueOnce(
      new AppError('payment_rejected', 422, 'The bank refused the payment.'),
    );

    const key = 'refused-then-fixed-1';
    const refused = await client.createPayment(EUR, key);
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ code: 'payment_rejected' });
    expect(t.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM payments')?.n).toBe(0);

    const fixed = await client.createPayment({ ...EUR, amountMinor: 500 }, key);
    expect(fixed.statusCode).toBe(201);
  });

  it('does not send the same attempt twice at once', async () => {
    const { client } = await setup();
    const mock = t.ctx.providers.mock();
    if (!mock) throw new Error('mock bank missing');
    const real = mock.createPayment.bind(mock);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(mock, 'createPayment').mockImplementationOnce(async (input, ctx) => {
      await gate;
      return real(input, ctx);
    });

    const key = 'double-submit-key-1';
    const first = client.createPayment(EUR, key);
    // The row is written before the provider call, so the second request finds an attempt that is still running.
    await vi.waitFor(() => {
      expect(t.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM payments')?.n).toBe(1);
    });
    const second = await client.createPayment(EUR, key);
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: 'conflict' });

    release();
    expect((await first).statusCode).toBe(201);
  });
});

describe('the journey through the bank', () => {
  it('goes Pending, Authorised, Executed, Settled for a bank that settles, updating from webhooks', async () => {
    const { client, tick } = await setup();
    const payment = await create(client);

    const { bankLocation, resultPath } = await client.payAtBank(payment.authUrl as string);
    expect(bankLocation).toBe(
      `http://localhost:4200/api/payments/return?payment_id=${
        t.ctx.repos.payments.findById(payment.id)?.providerPaymentId
      }`,
    );
    expect(resultPath).toBe(`/payments/${payment.id}/result`);
    // The return handler asked the bank, so the customer lands on a page that is already up to date.
    expect((await fetchPayment(client, payment.id)).status).toBe('authorised');

    await tick(1); // the bank's "authorised" webhook arrives: nothing new
    expect((await fetchPayment(client, payment.id)).status).toBe('authorised');

    await tick(3);
    expect((await fetchPayment(client, payment.id)).status).toBe('executed');
    await tick(3);
    const settled = await fetchPayment(client, payment.id);
    expect(settled.status).toBe('settled');
    expect(statuses(settled)).toEqual(['pending', 'authorised', 'executed', 'settled']);
    expect(settled.failureReason).toBeNull();
  });

  it('ends at Executed for a bank where no settlement step follows', async () => {
    const { client, tick } = await setup();
    const payment = await create(client, GBP);
    expect(payment.settlementExpected).toBe(false);

    await client.payAtBank(payment.authUrl as string);
    await tick(4);
    await tick(10);
    const done = await fetchPayment(client, payment.id);
    expect(done.status).toBe('executed');
    expect(statuses(done)).toEqual(['pending', 'authorised', 'executed']);
    // Nothing is left to wait for, so the poller leaves it alone.
    expect(t.ctx.repos.payments.listDueForPoll('9999-01-01', '9999-01-01')).toEqual([]);
  });

  it('fails when the customer cannot complete authentication', async () => {
    const { client, tick } = await setup();
    const payment = await create(client);
    await client.payAtBank(payment.authUrl as string, { outcome: 'test_authorisation_failed' });
    await tick(1);

    const failed = await fetchPayment(client, payment.id);
    expect(failed).toMatchObject({
      status: 'failed',
      failureReason: 'authorisation_failed',
      authUrl: null,
    });
    expect(statuses(failed)).toEqual(['pending', 'failed']);
  });

  it('fails when the bank rejects the payment after authorising it', async () => {
    const { client, tick } = await setup();
    const payment = await create(client);
    await client.payAtBank(payment.authUrl as string, { outcome: 'test_execution_rejected' });
    await tick(4);

    const failed = await fetchPayment(client, payment.id);
    expect(failed).toMatchObject({ status: 'failed', failureReason: 'execution_rejected' });
    expect(statuses(failed)).toEqual(['pending', 'authorised', 'failed']);
  });

  it('fails for insufficient funds when the customer cannot cover it', async () => {
    const { client, tick } = await setup();
    // Ben has a tight month: about 142 euros on the account.
    const payment = await create(client, { ...EUR, amountMinor: 200_000 });
    await client.payAtBank(payment.authUrl as string, { persona: 'ben' });
    await tick(4);

    const failed = await fetchPayment(client, payment.id);
    expect(failed).toMatchObject({ status: 'failed', failureReason: 'insufficient_funds' });
  });

  it('is cancelled when the customer backs out at the bank, and says they abandoned it', async () => {
    const { client } = await setup();
    const payment = await create(client);
    const { resultPath } = await client.payAtBank(payment.authUrl as string, {
      decision: 'cancel',
    });

    expect(resultPath).toBe(`/payments/${payment.id}/result?abandoned=1`);
    expect(await fetchPayment(client, payment.id)).toMatchObject({
      status: 'cancelled',
      failureReason: 'cancelled',
    });
  });

  it('fails at the bank when its payment page is down', async () => {
    const { client } = await setup();
    const payment = await create(client, { ...EUR, institutionId: 'mock:mock-bank-unhealthy' });
    const page = await t.app.inject({
      method: 'GET',
      url: new URL(payment.authUrl as string).pathname + new URL(payment.authUrl as string).search,
    });
    expect(page.statusCode).toBe(503);

    const back = await client.get(
      `/api/payments/return?payment_id=${
        t.ctx.repos.payments.findById(payment.id)?.providerPaymentId
      }`,
    );
    expect(back.statusCode).toBe(302);
    expect(await fetchPayment(client, payment.id)).toMatchObject({
      status: 'failed',
      failureReason: 'provider_error',
    });
  });

  it('expires when nobody approves it within the window, via the bank and via our own clock', async () => {
    const { client, tick } = await setup();
    const viaBank = await create(client);
    await tick(16 * 60);
    expect(await fetchPayment(client, viaBank.id)).toMatchObject({
      status: 'failed',
      failureReason: 'expired',
    });

    // Without the bank's help (no webhook, and the bank still thinks it is open) the app gives up by itself.
    const alone = await create(client, GBP);
    t.clock.advance(16 * 60_000);
    await t.ctx.payments.pollDue();
    expect(await fetchPayment(client, alone.id)).toMatchObject({
      status: 'failed',
      failureReason: 'expired',
    });
  });

  it('keeps the approval link working for resuming while the payment is pending', async () => {
    const { client } = await setup();
    const payment = await create(client);
    const again = await fetchPayment(client, payment.id);
    expect(again.authUrl).toBe(payment.authUrl);

    // A bank page that was opened but not finished can be opened again.
    const link = new URL(payment.authUrl as string);
    const page = await t.app.inject({ method: 'GET', url: `${link.pathname}${link.search}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Approve payment');
    expect(page.body).toContain('€12.34');
    const reopened = await t.app.inject({ method: 'GET', url: `${link.pathname}${link.search}` });
    expect(reopened.statusCode).toBe(200);
  });

  it('refuses a bank page link with a wrong resource token', async () => {
    const { client } = await setup();
    const payment = await create(client);
    const link = new URL(payment.authUrl as string);
    link.searchParams.set('resource_token', 'mbk_pay_forged');
    const page = await t.app.inject({ method: 'GET', url: `${link.pathname}${link.search}` });
    expect(page.statusCode).toBe(400);
  });
});

describe('webhooks', () => {
  const secret = (): string => mockWebhookSecret(t.ctx.config.sessionSecret);

  const send = (
    body: object | string,
    options: { at?: number; signature?: string; headers?: Record<string, string> } = {},
  ) => {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const seconds = options.at ?? Math.floor(t.clock.now().getTime() / 1000);
    return t.app.inject({
      method: 'POST',
      url: '/api/webhooks/mock',
      headers: {
        'content-type': 'application/json',
        'x-mock-signature': options.signature ?? signMockWebhook(secret(), seconds, raw),
        ...options.headers,
      },
      payload: raw,
    });
  };

  const event = (type: string, paymentId: string, id: string, extra: object = {}) => ({
    type,
    event_version: 1,
    event_id: id,
    payment_id: paymentId,
    ...extra,
  });

  async function pending() {
    const ctx = await setup();
    const payment = await create(ctx.client);
    const providerId = t.ctx.repos.payments.findById(payment.id)?.providerPaymentId as string;
    return { ...ctx, payment, providerId };
  }

  it('rejects a webhook without a valid signature and changes nothing', async () => {
    const { client, payment, providerId } = await pending();
    const body = event('payment_executed', providerId, 'evt_forged_1', {
      executed_at: '2026-10-28T10:00:00Z',
    });

    const none = await t.app.inject({
      method: 'POST',
      url: '/api/webhooks/mock',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
    expect(none.statusCode).toBe(401);
    expect(none.json()).toMatchObject({ code: 'invalid_webhook_signature' });

    const wrong = await send(body, {
      signature: `t=${Math.floor(t.clock.now().getTime() / 1000)},v1=${'0'.repeat(64)}`,
    });
    expect(wrong.statusCode).toBe(401);

    const garbled = await send(body, { signature: 'nonsense' });
    expect(garbled.statusCode).toBe(401);

    // Signed for one body, delivered with another.
    const raw = JSON.stringify(body);
    const tampered = await send(raw.replace('evt_forged_1', 'evt_forged_2'), {
      signature: signMockWebhook(secret(), Math.floor(t.clock.now().getTime() / 1000), raw),
    });
    expect(tampered.statusCode).toBe(401);

    expect((await fetchPayment(client, payment.id)).status).toBe('pending');
    expect(t.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM webhook_events')?.n).toBe(0);
  });

  it('rejects a correctly signed webhook that is too old, so a captured request cannot be replayed later', async () => {
    const { client, payment, providerId } = await pending();
    const body = event('payment_executed', providerId, 'evt_old_1');
    const stale = await send(body, { at: Math.floor(t.clock.now().getTime() / 1000) - 6 * 60 });
    expect(stale.statusCode).toBe(401);
    expect(stale.json().detail).toContain('stale');
    expect((await fetchPayment(client, payment.id)).status).toBe('pending');
  });

  it('applies a valid event once and acknowledges a re-delivery as a duplicate', async () => {
    const { client, payment, providerId } = await pending();
    const body = event('payment_authorized', providerId, 'evt_auth_1', {
      authorized_at: '2026-10-28T10:00:05Z',
    });

    const first = await send(body);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ status: 'applied' });
    expect((await fetchPayment(client, payment.id)).status).toBe('authorised');

    const again = await send(body);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ status: 'duplicate' });

    const stored = await fetchPayment(client, payment.id);
    expect(statuses(stored)).toEqual(['pending', 'authorised']);
    expect(t.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM webhook_events')?.n).toBe(1);
  });

  it('does not let a late event move a payment backwards', async () => {
    const { client, payment, providerId } = await pending();
    expect((await send(event('payment_executed', providerId, 'evt_exec_1'))).json()).toEqual({
      status: 'applied',
    });
    // The "authorised" event overtook nothing: it was merely delivered afterwards.
    expect((await send(event('payment_authorized', providerId, 'evt_auth_2'))).json()).toEqual({
      status: 'ignored',
    });
    expect((await fetchPayment(client, payment.id)).status).toBe('executed');
  });

  it('does not reopen a payment that has already failed', async () => {
    const { client, payment, providerId } = await pending();
    await send(
      event('payment_failed', providerId, 'evt_fail_1', {
        failure_stage: 'authorizing',
        failure_reason: 'authorization_failed',
      }),
    );
    expect((await send(event('payment_executed', providerId, 'evt_exec_2'))).json()).toEqual({
      status: 'ignored',
    });
    expect(await fetchPayment(client, payment.id)).toMatchObject({
      status: 'failed',
      failureReason: 'authorisation_failed',
    });
  });

  it('acknowledges events for payments it does not know, and event types it does not act on', async () => {
    const { providerId } = await pending();
    const unknown = await send(event('payment_executed', 'mpay_does_not_exist', 'evt_x_1'));
    expect(unknown.statusCode).toBe(200);
    expect(unknown.json()).toEqual({ status: 'unknown_payment' });

    const other = await send(event('refund_executed', providerId, 'evt_refund_1'));
    expect(other.json()).toEqual({ status: 'unsupported_event' });

    const noPayment = await send({ type: 'payout_executed', event_id: 'evt_payout_1' });
    expect(noPayment.json()).toEqual({ status: 'unsupported_event' });
  });

  it('rejects a body that is not an event, even when signed', async () => {
    await pending();
    expect((await send('not json')).statusCode).toBe(400);
    expect((await send({ hello: 'world' })).statusCode).toBe(400);
  });

  it('refuses webhooks for providers that are not enabled', async () => {
    await pending();
    const response = await t.app.inject({
      method: 'POST',
      url: '/api/webhooks/truelayer',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'provider_not_available' });
  });

  it('shows each webhook in the Inspector as an inbound call with the signature masked', async () => {
    const { client, providerId } = await pending();
    await send(event('payment_authorized', providerId, 'evt_inspect_1'));

    const calls = InspectorCallList.parse((await client.get('/api/inspector/calls')).json()).items;
    const inbound = calls.find((call) => call.direction === 'inbound');
    expect(inbound).toMatchObject({
      label: 'Webhook: payment_authorized',
      provider: 'mock',
      method: 'POST',
      url: '/api/webhooks/mock',
      status: 200,
      response: { body: { status: 'applied' } },
    });
    expect(inbound?.request.headers['x-mock-signature']).toBe('[redacted]');
  });
});

describe('when webhooks do not arrive', () => {
  it('polls the bank for payments nobody has heard about, then stops once they are final', async () => {
    const { client, tick } = await setup();
    const mock = t.ctx.providers.mock();
    if (!mock) throw new Error('mock bank missing');
    const payment = await create(client);
    await client.payAtBank(payment.authUrl as string);

    // The app's webhook endpoint is down: the bank advances, its deliveries fail and wait for a retry.
    const down = vi
      .spyOn(t.ctx.payments, 'handleWebhook')
      .mockRejectedValue(new AppError('internal_error', 500, 'down'));
    await tick(4);
    await tick(4);
    expect((await fetchPayment(client, payment.id)).status).toBe('authorised');

    // Not yet: a payment that was looked at a few seconds ago is left alone.
    await t.ctx.payments.pollDue();
    expect((await fetchPayment(client, payment.id)).status).toBe('authorised');

    t.clock.advance(31_000);
    await t.ctx.payments.pollDue();
    expect((await fetchPayment(client, payment.id)).status).toBe('settled');
    down.mockRestore();

    // Final payments are not asked about again.
    const asked = vi.spyOn(mock, 'getPayment');
    t.clock.advance(120_000);
    await t.ctx.payments.pollDue();
    expect(asked).not.toHaveBeenCalled();
  });

  it('keeps retrying failed deliveries, and the late webhooks then catch the payment up', async () => {
    const { client, tick } = await setup();
    const payment = await create(client);
    await client.payAtBank(payment.authUrl as string);

    const down = vi
      .spyOn(t.ctx.payments, 'handleWebhook')
      .mockRejectedValue(new AppError('internal_error', 500, 'down'));
    await tick(4);
    const outbox = t.db.all<{ attempts: number; delivered_at: string | null }>(
      'SELECT * FROM mock_outbox',
    );
    expect(outbox.length).toBeGreaterThan(0);
    expect(outbox.every((row) => row.delivered_at === null && row.attempts === 1)).toBe(true);

    down.mockRestore();
    await tick(5); // past the first backoff, and the bank has settled in the meantime
    const after = t.db.all<{ delivered_at: string | null }>('SELECT * FROM mock_outbox');
    expect(after.every((row) => row.delivered_at !== null)).toBe(true);
    const caughtUp = await fetchPayment(client, payment.id);
    expect(statuses(caughtUp)).toEqual(['pending', 'authorised', 'executed', 'settled']);
  });

  it('"check now" asks the bank straight away', async () => {
    const { client } = await setup();
    const payment = await create(client);
    await client.payAtBank(payment.authUrl as string, { decision: 'cancel' });
    t.ctx.repos.payments.update(
      payment.id,
      { status: 'pending', failureReason: null },
      '2026-10-28T10:00:00.000Z',
    );
    expect((await fetchPayment(client, payment.id)).status).toBe('pending');

    const synced = await client.post(`/api/payments/${payment.id}/sync`);
    expect(synced.statusCode).toBe(200);
    expect(Payment.parse(synced.json()).status).toBe('cancelled');
  });

  it('does not let one customer look at or sync another customer’s payment', async () => {
    const { client } = await setup();
    const payment = await create(client);
    const stranger = await newClient(t);
    expect((await stranger.get(`/api/payments/${payment.id}`)).statusCode).toBe(404);
    expect((await stranger.post(`/api/payments/${payment.id}/sync`)).statusCode).toBe(404);
  });
});

describe('the return endpoint', () => {
  it('sends a browser that comes back with an unknown payment to the list, revealing nothing', async () => {
    const { client } = await setup();
    const unknown = await client.get('/api/payments/return?payment_id=mpay_nope');
    expect(unknown.statusCode).toBe(302);
    expect(unknown.headers['location']).toBe('/payments');
    const none = await client.get('/api/payments/return');
    expect(none.headers['location']).toBe('/payments');
  });

  it('works without the session cookie, because the customer arrives from another site', async () => {
    const { client } = await setup();
    const payment = await create(client);
    const providerId = t.ctx.repos.payments.findById(payment.id)?.providerPaymentId;
    const bare = await t.app.inject({
      method: 'GET',
      url: `/api/payments/return?payment_id=${providerId}`,
    });
    expect(bare.statusCode).toBe(302);
    expect(bare.headers['location']).toBe(`/payments/${payment.id}/result`);
  });
});

describe('payments and the customer’s accounts', () => {
  it('shows an executed payment in the paying customer’s own mock accounts after a refresh', async () => {
    const { client, tick } = await setup();
    await client.connectBank({ persona: 'anna' });
    const accounts = AccountList.parse((await client.get('/api/accounts')).json()).items;
    const current = accounts.find((a) => a.type === 'current');
    if (!current) throw new Error('no current account');
    const before = current.balance.amountMinor;

    const payment = await create(client, { ...EUR, amountMinor: 4_250, reference: 'Gift' });
    await client.payAtBank(payment.authUrl as string, { persona: 'anna' });
    await tick(4);
    await tick(70); // past the refresh cool-down, and the payment has settled

    const refreshed = await client.post(`/api/accounts/${current.id}/refresh`);
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().account.balance.amountMinor).toBe(before - 4_250);

    const page = TransactionPage.parse(
      (await client.get(`/api/transactions?accountId=${current.id}&q=Mustermann&limit=10`)).json(),
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      amount: { amountMinor: -4_250, currency: 'EUR' },
      status: 'booked',
    });
    expect(page.items[0]?.description).toContain('ERIKA MUSTERMANN');
    expect(page.items[0]?.description).toContain('GIFT');

    // Someone else connecting the very same demo customer does not see it: payments belong to the person who made them.
    const other = await newClient(t);
    await other.connectBank({ persona: 'anna' });
    const theirs = AccountList.parse((await other.get('/api/accounts')).json()).items.find(
      (a) => a.type === 'current',
    );
    expect(theirs?.balance.amountMinor).toBe(before);
  });

  it('does not touch the accounts for a payment that failed', async () => {
    const { client, tick } = await setup();
    await client.connectBank({ persona: 'anna' });
    const current = AccountList.parse((await client.get('/api/accounts')).json()).items.find(
      (a) => a.type === 'current',
    );
    const payment = await create(client);
    await client.payAtBank(payment.authUrl as string, { outcome: 'test_execution_rejected' });
    await tick(10);
    await tick(70);

    const refreshed = await client.post(`/api/accounts/${current?.id}/refresh`);
    expect(refreshed.json().account.balance.amountMinor).toBe(current?.balance.amountMinor);
  });
});

describe('demo: replay the last webhook', () => {
  it('re-sends the bank’s last event and the app recognises it as a duplicate', async () => {
    const { client, tick } = await setup();
    const payment = await create(client);
    await client.payAtBank(payment.authUrl as string);
    await tick(4);

    const before = await fetchPayment(client, payment.id);
    const replay = await client.post('/api/demo/actions', {
      action: 'replay_last_webhook',
      paymentId: payment.id,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().message).toMatch(/payment_(authorized|executed)/);
    expect(replay.json().message).toContain('recognised it as a duplicate');
    expect(await fetchPayment(client, payment.id)).toEqual(before);
  });

  it('says so when the bank has sent nothing yet, and refuses when demo controls are off', async () => {
    const { client } = await setup();
    const payment = await create(client);
    const none = await client.post('/api/demo/actions', {
      action: 'replay_last_webhook',
      paymentId: payment.id,
    });
    expect(none.json().message).toContain('has not sent a webhook');

    const noPayment = await client.post('/api/demo/actions', { action: 'replay_last_webhook' });
    expect(noPayment.statusCode).toBe(400);

    await t.close();
    t = await createTestApp({ demoControls: false });
    const locked = await newClient(t);
    const refused = await locked.post('/api/demo/actions', {
      action: 'replay_last_webhook',
      paymentId: 'pay_x',
    });
    expect(refused.statusCode).toBe(403);
  });
});
