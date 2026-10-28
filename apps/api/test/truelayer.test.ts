import { afterEach, describe, expect, it } from 'vitest';
import {
  AccountList,
  ConnectionList,
  InspectorCallList,
  TransactionPage,
} from '@ledger-lens/contracts';
import { fixedClock } from '../src/clock';
import { AppError } from '../src/errors';
import {
  InvalidGrantError,
  TokenRejectedError,
  type CallContext,
  type TokenSet,
} from '../src/providers/port';
import { TrueLayerProvider } from '../src/providers/truelayer/adapter';
import { InspectorStore } from '../src/modules/inspector/inspector-store';
import { EventBus } from '../src/modules/events/event-bus';
import { ProviderHttp } from '../src/providers/transport';
import { createTestApp, newClient, type Client, type TestApp } from './helpers';
import {
  TL_ACCOUNT_ID,
  TL_SAVINGS_ID,
  TrueLayerStub,
  fixture,
  truelayerConfig,
} from './truelayer-stub';

const CTX: CallContext = { sessionId: 'ses_test', connectionId: 'con_test' };
function adapter(stub = new TrueLayerStub()) {
  const clock = fixedClock('2026-10-28T10:00:00.000Z');
  const events = new EventBus();
  const inspector = new InspectorStore(events);
  const provider = new TrueLayerProvider({
    http: new ProviderHttp({
      provider: 'truelayer',
      mode: 'sandbox',
      transport: stub.transport,
      inspector,
      clock,
    }),
    config: truelayerConfig(),
    clock,
  });
  return { provider, stub, inspector };
}

/** Issues tokens the stub will accept, the way a real code exchange would. */
async function signedIn(provider: TrueLayerProvider): Promise<TokenSet> {
  const grant = await provider.completeConnection(
    {
      code: 'good-code',
      codeVerifier: 'v'.repeat(43),
      redirectUri: 'http://localhost:4200/api/connections/callback',
    },
    CTX,
  );
  return grant.tokens;
}

describe('TrueLayer adapter: connecting', () => {
  it('lists one sandbox bank and honours the search', async () => {
    const { provider } = adapter();
    const all = await provider.listInstitutions({});
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      id: 'truelayer:mock-bank',
      provider: 'truelayer',
      mode: 'sandbox',
      country: 'GB',
      capabilities: { accounts: true, payments: false },
    });
    expect(await provider.listInstitutions({ q: 'nope' })).toEqual([]);
    expect(await provider.listInstitutions({ country: 'de' })).toEqual([]);
  });

  it('builds an auth link with PKCE, the data scopes and the configured mock provider', async () => {
    const { provider } = adapter();
    const { authUrl } = await provider.startConnection({
      institutionId: 'truelayer:mock-bank',
      state: 'state-123',
      codeChallenge: 'c'.repeat(43),
      redirectUri: 'http://localhost:4200/api/connections/callback',
    });
    const url = new URL(authUrl);
    expect(url.origin).toBe('https://auth.truelayer-sandbox.com');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'sandbox-ledgerlens-fixture',
      scope: 'info accounts balance transactions offline_access',
      redirect_uri: 'http://localhost:4200/api/connections/callback',
      providers: 'uk-cs-mock',
      state: 'state-123',
      code_challenge: 'c'.repeat(43),
      code_challenge_method: 'S256',
    });
    expect(authUrl).not.toContain('fixture-secret');
  });

  it('refuses an institution that is not TrueLayer’s', async () => {
    const { provider } = adapter();
    await expect(
      provider.startConnection({
        institutionId: 'truelayer:other',
        state: 's',
        codeChallenge: 'c',
        redirectUri: 'http://x/cb',
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it.each([
    [
      { code: 'abc', state: 's' },
      { kind: 'code', code: 'abc' },
    ],
    [
      { error: 'access_denied', state: 's' },
      { kind: 'failure', outcome: 'denied' },
    ],
    [
      { error: 'access_denied', error_description: 'SCA timeout reached' },
      { kind: 'failure', outcome: 'timeout' },
    ],
    [{ error: 'provider_error' }, { kind: 'failure', outcome: 'unavailable' }],
    [{ error: 'invalid_request' }, { kind: 'failure', outcome: 'error' }],
    [{ state: 's' }, { kind: 'failure', outcome: 'error' }],
  ])('reads the redirect %j as %j', (query, expected) => {
    expect(adapter().provider.parseCallback(query)).toMatchObject(expected);
  });

  it('exchanges the code over JSON with the verifier, then reads the consent', async () => {
    const { provider, stub } = adapter();
    const grant = await provider.completeConnection(
      {
        code: 'good-code',
        codeVerifier: 'v'.repeat(43),
        redirectUri: 'http://localhost:4200/api/connections/callback',
      },
      CTX,
    );

    const exchange = stub.last('POST auth.truelayer-sandbox.com/connect/token');
    expect(exchange?.json).toMatchObject({
      grant_type: 'authorization_code',
      code: 'good-code',
      code_verifier: 'v'.repeat(43),
      redirect_uri: 'http://localhost:4200/api/connections/callback',
      client_id: 'sandbox-ledgerlens-fixture',
    });
    expect(grant.tokens).toEqual({
      accessToken: 'tl_at_0001_fixture',
      refreshToken: 'tl_rt_0001_fixture',
      expiresAt: '2026-10-28T11:00:00.000Z',
      scope: 'info accounts balance transactions offline_access',
    });
    expect(grant.consentExpiresAt).toBe('2027-01-26T09:58:59.000Z');
    expect(grant.permissions).toEqual(['accounts', 'balances', 'transactions']);
  });

  it('reports a dead authorisation code as invalid_state, and bad app credentials as a provider error', async () => {
    const { provider } = adapter();
    await expect(
      provider.completeConnection(
        { code: 'used-code', codeVerifier: 'v'.repeat(43), redirectUri: 'http://x/cb' },
        CTX,
      ),
    ).rejects.toMatchObject({ code: 'invalid_state' });

    const wrong = adapter(new TrueLayerStub());
    const broken = new TrueLayerProvider({
      http: new ProviderHttp({
        provider: 'truelayer',
        mode: 'sandbox',
        transport: wrong.stub.transport,
        inspector: wrong.inspector,
        clock: fixedClock('2026-10-28T10:00:00.000Z'),
      }),
      config: truelayerConfig({ clientSecret: 'wrong' }),
      clock: fixedClock('2026-10-28T10:00:00.000Z'),
    });
    await expect(
      broken.completeConnection(
        { code: 'good-code', codeVerifier: 'v'.repeat(43), redirectUri: 'http://x/cb' },
        CTX,
      ),
    ).rejects.toMatchObject({ code: 'provider_error', status: 502 });
  });

  it('rotates tokens on refresh and treats a spent refresh token as invalid_grant', async () => {
    const { provider } = adapter();
    const first = await signedIn(provider);
    const second = await provider.refreshTokens(first, CTX);
    expect(second.accessToken).toBe('tl_at_0002_fixture');
    expect(second.refreshToken).toBe('tl_rt_0002_fixture');
    await expect(provider.refreshTokens(first, CTX)).rejects.toBeInstanceOf(InvalidGrantError);
    await expect(
      provider.refreshTokens({ ...first, refreshToken: null }, CTX),
    ).rejects.toBeInstanceOf(InvalidGrantError);
  });
});

describe('TrueLayer adapter: reading data', () => {
  it('maps accounts and balances to minor units with masked identifiers', async () => {
    const { provider } = adapter();
    const tokens = await signedIn(provider);
    const accounts = await provider.fetchAccounts(tokens, CTX);

    expect(accounts).toHaveLength(2);
    const [current, savings] = accounts;
    expect(current).toMatchObject({
      providerAccountId: TL_ACCOUNT_ID,
      name: 'TRANSACTION ACCOUNT 1',
      type: 'current',
      currency: 'GBP',
      balance: { amountMinor: 110_000, currency: 'GBP' },
      availableBalance: { amountMinor: 107_655, currency: 'GBP' },
    });
    expect(current.maskedIdentifier).toMatch(/^GB•+\d{4}$|^GB.*3435$/);
    expect(current.maskedIdentifier).not.toContain('GB35CLRB04066800003435');
    expect(savings).toMatchObject({ providerAccountId: TL_SAVINGS_ID, type: 'savings' });
    // No IBAN: the sort code is shown, the account number is masked.
    expect(savings.maskedIdentifier).toMatch(/^04-00-72 /);
    expect(savings.maskedIdentifier).not.toContain('20000001');
    // 5000.10 as a float is 5000.099999999999909...: it must land on exactly 500010 minor units.
    expect(savings.balance.amountMinor).toBe(500_010);
  });

  it('maps transactions: UTC for zone-less stamps, offsets honoured, signs from the type, stable ids for rows without one', async () => {
    const { provider } = adapter();
    const tokens = await signedIn(provider);
    const rows = await provider.fetchTransactions(
      tokens,
      { providerAccountId: TL_ACCOUNT_ID, currency: 'GBP' },
      { from: '2025-09-01', to: '2026-10-28' },
      CTX,
    );

    const booked = rows.filter((r) => r.status === 'booked');
    const pending = rows.filter((r) => r.status === 'pending');
    expect(booked).toHaveLength(6);
    expect(pending).toHaveLength(1);

    const tesco = booked.find((r) => r.description === 'TESCO STORES 3297');
    expect(tesco).toMatchObject({
      providerTxnId: '2c2c1ffb7f8a43d5a0a6f0e2e6b3b9a1',
      bookedAt: '2026-10-26T00:00:00.000Z', // zone-less → UTC, whatever TZ the server runs in
      amount: { amountMinor: -2345, currency: 'GBP' },
      counterparty: 'Tesco',
      providerCategory: 'PURCHASE',
    });
    // A DEBIT sent as +9.99 is still money out.
    expect(booked.find((r) => r.description === 'NETFLIX.COM')?.amount.amountMinor).toBe(-999);
    expect(booked.find((r) => r.description === 'ACME LTD SALARY')?.amount.amountMinor).toBe(
      245_000,
    );
    expect(booked.find((r) => r.description === 'TFL TRAVEL CH')?.bookedAt).toBe(
      '2026-10-20T22:30:00.000Z',
    );

    const coffees = booked.filter((r) => r.description.startsWith('COSTA'));
    expect(coffees).toHaveLength(2);
    expect(new Set(coffees.map((c) => c.providerTxnId)).size).toBe(2); // two identical coffees do not collide
    expect(coffees[0].providerTxnId).toMatch(/^d_[0-9a-f]{20}-1$/);
    expect(coffees[1].providerTxnId).toMatch(/^d_[0-9a-f]{20}-2$/);

    expect(pending[0]).toMatchObject({ description: 'PRET A MANGER', status: 'pending' });
    expect(pending[0].providerTxnId).toMatch(/^p_/);
  });

  it('treats 501 on pending transactions as "none", not as a failure', async () => {
    const { provider } = adapter();
    const tokens = await signedIn(provider);
    const rows = await provider.fetchTransactions(
      tokens,
      { providerAccountId: TL_SAVINGS_ID, currency: 'GBP' },
      { from: '2025-09-01', to: '2026-10-28' },
      CTX,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'booked',
      description: 'INTEREST PAID',
      amount: { amountMinor: 1234 },
    });
  });

  it('sends the customer’s IP as X-PSU-IP only when they are present, and the Inspector masks it', async () => {
    const { provider, stub, inspector } = adapter();
    const tokens = await signedIn(provider);

    await provider.fetchConsent(tokens, { ...CTX, psuIp: '203.0.113.77' });
    expect(stub.last('GET api.truelayer-sandbox.com/data/v1/me')?.headers['x-psu-ip']).toBe(
      '203.0.113.77',
    );

    await provider.fetchConsent(tokens, CTX);
    expect(
      stub.last('GET api.truelayer-sandbox.com/data/v1/me')?.headers['x-psu-ip'],
    ).toBeUndefined();

    const call = inspector.list(CTX.sessionId).find((c) => c.request.headers['x-psu-ip']);
    expect(call?.request.headers['x-psu-ip']).toBe('203.0.113.•••');
    expect(call?.request.headers['authorization']).toMatch(/^Bearer ••••/);
  });
});

describe('TrueLayer adapter: failures', () => {
  const read = (stub: TrueLayerStub) => {
    const { provider } = adapter(stub);
    return { provider, run: async () => provider.fetchAccounts(await signedIn(provider), CTX) };
  };

  it('401 → TokenRejectedError, so the caller refreshes and retries', async () => {
    const stub = new TrueLayerStub();
    const { provider } = adapter(stub);
    const tokens = await signedIn(provider);
    stub.expireAccessToken();
    await expect(provider.fetchAccounts(tokens, CTX)).rejects.toBeInstanceOf(TokenRejectedError);
  });

  it('403 sca_exceeded → InvalidGrantError (sign in again), not a retry', async () => {
    const stub = new TrueLayerStub().once('GET api.truelayer-sandbox.com/data/v1/accounts', {
      status: 403,
      body: fixture('errors/sca-exceeded.json'),
    });
    await expect(read(stub).run()).rejects.toBeInstanceOf(InvalidGrantError);
  });

  it('429 → rate_limited carrying Retry-After', async () => {
    const stub = new TrueLayerStub().once('GET api.truelayer-sandbox.com/data/v1/accounts', {
      status: 429,
      body: fixture('errors/too-many-requests.json'),
      headers: { 'retry-after': '45' },
    });
    await expect(read(stub).run()).rejects.toMatchObject({
      code: 'rate_limited',
      retryAfterSeconds: 45,
    });
  });

  it('5xx → bank_unavailable', async () => {
    const stub = new TrueLayerStub().once('GET api.truelayer-sandbox.com/data/v1/accounts', {
      status: 500,
      body: fixture('errors/provider-error.json'),
    });
    await expect(read(stub).run()).rejects.toMatchObject({ code: 'bank_unavailable', status: 503 });
  });

  it('a response that does not match the documented shape is a 502, not a crash', async () => {
    const stub = new TrueLayerStub().once('GET api.truelayer-sandbox.com/data/v1/accounts', {
      status: 200,
      body: { results: [{ account_id: 7 }] },
    });
    await expect(read(stub).run()).rejects.toMatchObject({ code: 'provider_error', status: 502 });
  });
});

// ============================================================================================== through the BFF

let t: TestApp;
let stub: TrueLayerStub;

async function appWithTrueLayer(): Promise<Client> {
  stub = new TrueLayerStub();
  t = await createTestApp(
    { providers: { mock: { enabled: true }, truelayer: truelayerConfig(), monobank: null } },
    undefined,
    { truelayer: stub.transport },
  );
  return newClient(t);
}

async function connectTrueLayer(client: Client, code = 'good-code') {
  const start = await client.post('/api/connections', { institutionId: 'truelayer:mock-bank' });
  expect(start.statusCode).toBe(201);
  const { connectionId, authUrl } = start.json<{ connectionId: string; authUrl: string }>();
  const state = new URL(authUrl).searchParams.get('state') ?? '';
  const callback = await client.get(`/api/connections/callback?code=${code}&state=${state}`, {
    remoteAddress: '198.51.100.23',
  });
  return { connectionId, authUrl, location: callback.headers['location'] as string };
}

describe('TrueLayer through the BFF', () => {
  afterEach(async () => {
    await t.close();
  });

  it('connects, syncs accounts and transactions, and never exposes a token', async () => {
    const client = await appWithTrueLayer();
    const { location, authUrl } = await connectTrueLayer(client);
    expect(new URL(authUrl).host).toBe('auth.truelayer-sandbox.com');
    expect(location).toMatch(/^\/connect\/result\?status=success&connection=con_/);

    const accounts = AccountList.parse((await client.get('/api/accounts')).json());
    expect(accounts.items.map((a) => a.name).sort()).toEqual([
      'SAVINGS ACCOUNT 1',
      'TRANSACTION ACCOUNT 1',
    ]);
    expect(accounts.items.every((a) => a.institutionId === 'truelayer:mock-bank')).toBe(true);

    const page = TransactionPage.parse((await client.get('/api/transactions?limit=50')).json());
    expect(page.total).toBe(8); // 6 booked + 1 pending on the current account, 1 on savings
    expect(page.items.some((i) => i.status === 'pending')).toBe(true);

    const connections = ConnectionList.parse((await client.get('/api/connections')).json());
    expect(connections.items[0]).toMatchObject({
      status: 'active',
      provider: 'truelayer',
      permissions: ['accounts', 'balances', 'transactions'],
      consentExpiresAt: '2027-01-26T09:58:59.000Z',
    });

    // Everything a browser could read, searched for credentials.
    for (const url of [
      '/api/connections',
      '/api/accounts',
      '/api/inspector/calls',
      '/api/transactions',
    ]) {
      const body = (await client.get(url)).body;
      expect(body).not.toMatch(/tl_at_|tl_rt_|fixture-secret|good-code/);
    }
  });

  it('shows the real calls in the Inspector with credentials redacted', async () => {
    const client = await appWithTrueLayer();
    await connectTrueLayer(client);
    const calls = InspectorCallList.parse((await client.get('/api/inspector/calls')).json()).items;

    const exchange = calls.find((c) => c.label === 'Exchange authorisation code');
    expect(exchange).toMatchObject({
      provider: 'truelayer',
      direction: 'outbound',
      method: 'POST',
      status: 200,
    });
    expect(exchange?.url).toBe('https://auth.truelayer-sandbox.com/connect/token');
    expect(exchange?.request.body).toMatchObject({
      client_secret: '[redacted]',
      code: '[redacted]',
      code_verifier: '[redacted]',
      grant_type: 'authorization_code',
    });
    expect(JSON.stringify(calls)).not.toMatch(/tl_at_|tl_rt_|fixture-secret/);
    expect(calls.map((c) => c.label)).toContain('List accounts');
  });

  it('passes the customer’s IP to the bank while connecting and when they press Refresh', async () => {
    const client = await appWithTrueLayer();
    await connectTrueLayer(client);
    expect(stub.last('GET api.truelayer-sandbox.com/data/v1/accounts')?.headers['x-psu-ip']).toBe(
      '198.51.100.23',
    );

    const accounts = AccountList.parse((await client.get('/api/accounts')).json());
    t.clock.advance(60_000);
    const refresh = await client.post(`/api/accounts/${accounts.items[0].id}/refresh`, undefined, {
      remoteAddress: '203.0.113.9',
    });
    expect(refresh.statusCode).toBe(200);
    expect(stub.last('GET api.truelayer-sandbox.com/data/v1/me')?.headers['x-psu-ip']).toBe(
      '203.0.113.9',
    );
  });

  it('refreshes an expired access token once and retries, even when two reads race', async () => {
    const client = await appWithTrueLayer();
    await connectTrueLayer(client);
    const accounts = AccountList.parse((await client.get('/api/accounts')).json());
    const before = stub.count('POST auth.truelayer-sandbox.com/connect/token');

    stub.expireAccessToken(); // the bank stops honouring the token before our clock says it expired
    t.clock.advance(60_000);
    const refresh = await client.post(`/api/accounts/${accounts.items[0].id}/refresh`);
    expect(refresh.statusCode).toBe(200);
    expect(stub.count('POST auth.truelayer-sandbox.com/connect/token')).toBe(before + 1);
    expect(stub.last('POST auth.truelayer-sandbox.com/connect/token')?.json).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'tl_rt_0001_fixture',
    });

    // Proactive refresh: the next refresh happens because our clock says the new token is nearly dead.
    t.clock.advance(3_560_000);
    const again = await client.post(`/api/accounts/${accounts.items[0].id}/refresh`);
    expect(again.statusCode).toBe(200);
    expect(stub.last('POST auth.truelayer-sandbox.com/connect/token')?.json).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'tl_rt_0002_fixture',
    });
  });

  it('moves the connection to needs_reauth when the bank says strong authentication has expired', async () => {
    const client = await appWithTrueLayer();
    await connectTrueLayer(client);
    const accounts = AccountList.parse((await client.get('/api/accounts')).json());

    stub.once('GET api.truelayer-sandbox.com/data/v1/me', {
      status: 403,
      body: fixture('errors/sca-exceeded.json'),
    });
    t.clock.advance(60_000);
    const refresh = await client.post(`/api/accounts/${accounts.items[0].id}/refresh`);
    expect(refresh.statusCode).toBe(401);
    expect(refresh.json()).toMatchObject({ code: 'reauth_required' });
    const connections = ConnectionList.parse((await client.get('/api/connections')).json());
    expect(connections.items[0].status).toBe('needs_reauth');
  });

  it('abandons the connection when the code exchange fails', async () => {
    const client = await appWithTrueLayer();
    const { location } = await connectTrueLayer(client, 'used-code');
    expect(location).toBe('/connect/result?status=invalid_state');
    expect(ConnectionList.parse((await client.get('/api/connections')).json()).items).toHaveLength(
      0,
    );
  });

  it('deleting the connection asks TrueLayer to delete the credentials', async () => {
    const client = await appWithTrueLayer();
    const { connectionId } = await connectTrueLayer(client);
    const removed = await client.delete(`/api/connections/${connectionId}`);
    expect(removed.statusCode).toBe(204);
    expect(stub.count('DELETE auth.truelayer-sandbox.com/api/delete')).toBe(1);
  });
});
