import { generateKeyPairSync } from 'node:crypto';
import { AccountList, Payment } from '@ledger-lens/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { MOCK_CLIENT_SECRET } from '../src/providers/mock/store';
import { mockWebhookSecret } from '../src/providers/mock/signature';
import { createTestApp, newClient, type TestApp } from './helpers';
import { TrueLayerStub, truelayerConfig } from './truelayer-stub';

let t: TestApp;
afterEach(async () => {
  await t.close();
});

const MERCHANT_GBP = 'f3a9c1de-2b4e-4d7a-8c10-9e6b5a4d3c21';

interface Secret {
  name: string;
  value: string;
}

/**
 * The audit the provider-adapter skill asks for: run a whole connect, refresh and payment through both providers, collect
 * every secret the server holds (tokens, client secrets, keys, signatures, resource tokens), and search everything a
 * person or an operator could ever see for any of them: every response the browser got, the Inspector, the live event
 * stream, the server log, and the database rows (where credentials may only appear sealed).
 */
describe('redaction audit', () => {
  async function run() {
    const logs: string[] = [];
    const stub = new TrueLayerStub();
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp521r1' });
    stub.trustSigningKey('audit-key-1', publicKey);
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    t = await createTestApp(
      {
        logLevel: 'debug',
        providers: {
          mock: { enabled: true },
          truelayer: truelayerConfig({
            signing: { keyId: 'audit-key-1', privateKeyPem: pem },
            beneficiary: { type: 'merchant_account', merchantAccountIds: { GBP: MERCHANT_GBP } },
          }),
          monobank: null,
        },
      },
      undefined,
      { truelayer: stub.transport },
      { write: (line) => logs.push(line) },
    );
    const client = await newClient(t);
    const sessionId = t.db.get<{ id: string }>('SELECT id FROM sessions')?.id ?? '';
    const events: string[] = [];
    t.ctx.events.subscribe(sessionId, (event) => {
      // A pending payment's own bank link is meant for its owner (it is how they get to the bank): it is the one
      // credential allowed in the event stream, and only in that field.
      const copy = JSON.parse(JSON.stringify(event)) as { payment?: { authUrl?: unknown } };
      if (copy.payment) delete copy.payment.authUrl;
      events.push(JSON.stringify(copy));
    });

    // ------------------------------------------------------------------------------------------ the mock bank
    await client.connectBank({ persona: 'anna' });
    const accounts = AccountList.parse((await client.get('/api/accounts')).json()).items;
    t.clock.advance(60_000);
    await client.post(`/api/accounts/${accounts[0]?.id}/refresh`);

    const mock = t.ctx.providers.mock();
    const created = await client.createPayment({
      institutionId: 'mock:mock-bank',
      amountMinor: 1_234,
      currency: 'EUR',
      beneficiary: { type: 'iban', name: 'Erika Mustermann', iban: 'DE89370400440532013000' },
      reference: 'Audit',
    });
    const mockPayment = Payment.parse(created.json());
    await client.payAtBank(mockPayment.authUrl as string);
    t.clock.advance(4_000);
    await mock?.tick();
    t.clock.advance(4_000);
    await mock?.tick();
    await client.post('/api/demo/actions', {
      action: 'replay_last_webhook',
      paymentId: mockPayment.id,
    });

    // ------------------------------------------------------------------------------------------ TrueLayer
    const start = await client.post('/api/connections', { institutionId: 'truelayer:mock-bank' });
    const { authUrl } = start.json<{ authUrl: string }>();
    const state = new URL(authUrl).searchParams.get('state') ?? '';
    await client.get(`/api/connections/callback?code=good-code&state=${state}`, {
      remoteAddress: '198.51.100.23',
    });
    const tlAccounts = AccountList.parse((await client.get('/api/accounts')).json()).items.filter(
      (account) => account.institutionId === 'truelayer:mock-bank',
    );
    t.clock.advance(60_000);
    await client.post(
      `/api/accounts/${tlAccounts[0]?.id}/refresh`,
      {},
      { remoteAddress: '198.51.100.23' },
    );
    const tlCreated = await client.createPayment({
      institutionId: 'truelayer:mock-bank',
      amountMinor: 2_500,
      currency: 'GBP',
      reference: 'Audit',
    });
    const tlPayment = Payment.parse(tlCreated.json());
    stub.setPayment(
      t.ctx.repos.payments.findById(tlPayment.id)?.providerPaymentId ?? '',
      'payments/authorized.json',
    );
    await client.post(`/api/payments/${tlPayment.id}/sync`);

    // One more that nobody approves: it stays pending, so its sealed bank link is still stored.
    const waitingResponse = await client.createPayment({
      institutionId: 'mock:mock-bank',
      amountMinor: 500,
      currency: 'EUR',
      beneficiary: { type: 'iban', name: 'Erika Mustermann', iban: 'DE89370400440532013000' },
      reference: 'Waiting',
    });
    const waitingPayment = Payment.parse(waitingResponse.json());

    // Look at the Inspector and the lists the way a person would.
    for (const url of [
      '/api/inspector/calls',
      '/api/payments',
      '/api/connections',
      '/api/accounts',
      '/api/transactions?limit=200',
    ]) {
      await client.get(url);
    }

    return { client, stub, pem, logs, events, mockPayment, tlPayment, waitingPayment };
  }

  function secretsOf(run: Awaited<ReturnType<typeof runAll>>): Secret[] {
    const secrets: Secret[] = [];
    for (const connection of t.ctx.repos.connections.listBySession(
      t.db.get<{ id: string }>('SELECT id FROM sessions')?.id ?? '',
    )) {
      const tokens = t.ctx.access.loadTokens(connection);
      secrets.push({ name: `${connection.provider} access token`, value: tokens.accessToken });
      if (tokens.refreshToken) {
        secrets.push({ name: `${connection.provider} refresh token`, value: tokens.refreshToken });
      }
    }
    for (const line of run.pem.split('\n').filter((l) => l.length > 20 && !l.startsWith('-----'))) {
      secrets.push({ name: 'the TrueLayer signing key', value: line });
    }
    for (const request of run.stub.paymentRequests()) {
      const signature = request.headers['tl-signature'];
      if (signature) secrets.push({ name: 'a Tl-Signature header', value: signature });
    }
    const mockResource = new URL(run.mockPayment.authUrl as string).searchParams.get(
      'resource_token',
    );
    const waitingResource = new URL(run.waitingPayment.authUrl as string).searchParams.get(
      'resource_token',
    );
    const tlResource = 'fixture-resource-token-not-real';
    secrets.push(
      { name: 'the TrueLayer client secret', value: 'fixture-secret-never-real' },
      { name: 'the mock bank client secret', value: MOCK_CLIENT_SECRET },
      { name: 'the mock bank payment resource token', value: mockResource ?? '' },
      { name: 'a waiting payment’s resource token', value: waitingResource ?? '' },
      { name: 'the TrueLayer payment resource token', value: tlResource },
      { name: 'the session secret', value: t.ctx.config.sessionSecret },
      { name: 'the webhook signing secret', value: mockWebhookSecret(t.ctx.config.sessionSecret) },
      {
        name: 'the token encryption key',
        value: t.ctx.config.tokenEncryptionKey.toString('base64'),
      },
      { name: 'the session cookie', value: run.client.cookies.get('ll_sid') ?? '' },
    );
    return secrets.filter((secret) => secret.value.length >= 12);
  }

  // `run` returns a promise; this alias keeps the helper's parameter type readable.
  const runAll = run;

  it('finds no credential anywhere a person, a log reader or a database dump could look', async () => {
    const result = await runAll();
    const secrets = secretsOf(result);
    expect(secrets.map((s) => s.name)).toEqual(
      expect.arrayContaining([
        'mock access token',
        'mock refresh token',
        'truelayer access token',
        'truelayer refresh token',
        'the TrueLayer signing key',
        'a Tl-Signature header',
        'the mock bank payment resource token',
      ]),
    );

    // The one credential allowed out: a pending payment hands its owner the link to the bank in `authUrl`, and nowhere else.
    const withoutOwnLink = (text: string): string =>
      text
        .replace(/"authUrl":"[^"]*"/g, '"authUrl":"[own bank link]"')
        .replace(/\\"authUrl\\":\\"[^"\\]*\\"/g, '"authUrl":"[own bank link]"');

    const tables = [
      'sessions',
      'connections',
      'accounts',
      'transactions',
      'payments',
      'webhook_events',
      'sync_jobs',
    ];
    const database = tables
      .map((table) => `${table}: ${JSON.stringify(t.db.all(`SELECT * FROM ${table}`))}`)
      .join('\n');

    const channels: Record<string, string> = {
      'the responses the browser received': withoutOwnLink(
        JSON.stringify(result.client.transcript),
      ),
      'the live event stream': result.events.join('\n'),
      'the server log': result.logs.join('\n'),
      'the database (outside the sealed columns)': database,
    };

    const leaks: string[] = [];
    for (const [channel, text] of Object.entries(channels)) {
      for (const secret of secrets) {
        if (text.includes(secret.value)) leaks.push(`${channel} contains ${secret.name}`);
      }
    }
    expect(leaks).toEqual([]);

    // The scan is not vacuous: those channels were full of traffic, and the secrets did travel to the providers.
    expect(result.logs.length).toBeGreaterThan(20);
    expect(result.client.transcript.length).toBeGreaterThan(12);
    expect(JSON.stringify(result.stub.requests)).toContain('fixture-secret-never-real');
    expect(
      t.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM connections WHERE tokens_enc IS NOT NULL')
        ?.n,
    ).toBe(2);
    // A bank link that is still needed is stored sealed; the ones that are not needed any more are gone.
    expect(
      t.db.get<{ enc: string }>("SELECT auth_url_enc AS enc FROM payments WHERE status = 'pending'")
        ?.enc ?? '',
    ).toMatch(/^v1\./);
    expect(
      t.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM payments WHERE status <> 'pending' AND auth_url_enc IS NOT NULL",
      )?.n,
    ).toBe(0);
  });
});
