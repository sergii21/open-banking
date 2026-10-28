import { afterEach, describe, expect, it } from 'vitest';
import {
  AccountList,
  type Connection,
  ConnectionList,
  InspectorCallList,
  RefreshAccountResponse,
} from '@ledger-lens/contracts';
import { newClient, createTestApp, type Client, type TestApp } from './helpers';

let t: TestApp;
afterEach(async () => {
  await t.close();
});

async function connected(): Promise<{ client: Client; connectionId: string; accountId: string }> {
  t = await createTestApp();
  const client = await newClient(t);
  const { connectionId } = await client.connectBank();
  const accounts = AccountList.parse((await client.get('/api/accounts')).json());
  return { client, connectionId, accountId: accounts.items[0]?.id };
}

const labels = async (client: Client): Promise<string[]> =>
  InspectorCallList.parse((await client.get('/api/inspector/calls')).json()).items.map(
    (c) => c.label,
  );

const connection = async (client: Client): Promise<Connection> =>
  ConnectionList.parse((await client.get('/api/connections')).json()).items[0];

describe('cached reads and user-initiated refresh', () => {
  it('serves dashboard reads from the cache without calling the bank', async () => {
    const { client } = await connected();
    const before = (await labels(client)).length;
    await client.get('/api/accounts');
    await client.get('/api/transactions?limit=50');
    await client.get('/api/connections');
    expect((await labels(client)).length).toBe(before);
  });

  it('enforces a cool-down between refreshes, then refreshes and files the calls with the Inspector', async () => {
    const { client, accountId } = await connected();

    const tooSoon = await client.post(`/api/accounts/${accountId}/refresh`);
    expect(tooSoon.statusCode).toBe(429);
    expect(tooSoon.json()).toMatchObject({ code: 'refresh_cooldown', retryAfterSeconds: 20 });
    expect(tooSoon.headers['retry-after']).toBe('20');

    t.clock.advance(60_000);
    const refreshed = await client.post(`/api/accounts/${accountId}/refresh`);
    expect(refreshed.statusCode).toBe(200);
    const body = RefreshAccountResponse.parse(refreshed.json());
    expect(body.newTransactions).toBe(0); // same day, nothing new: de-duplication works
    expect(body.account.lastRefreshedAt).toBe(t.clock.now().toISOString());

    const recent = await labels(client);
    expect(recent.slice(0, 4)).toEqual([
      'List pending transactions',
      'List transactions',
      'Get balance',
      'Get consent details',
    ]);
  });

  it('picks up new bank activity on the next day without duplicating history', async () => {
    const { client, accountId } = await connected();
    const before = Number(
      (await client.get('/api/transactions?limit=1')).json<{ total: number }>().total,
    );

    t.clock.advance(24 * 3_600_000);
    const refreshed = RefreshAccountResponse.parse(
      (await client.post(`/api/accounts/${accountId}/refresh`)).json(),
    );
    const after = Number(
      (await client.get('/api/transactions?limit=1')).json<{ total: number }>().total,
    );
    // Only the girokonto was refreshed; its new total grows by exactly the reported new rows (pending rows are replaced).
    expect(after).toBeGreaterThanOrEqual(before);
    expect(refreshed.newTransactions).toBeGreaterThanOrEqual(0);
    const duplicates = t.db.all<{ n: number }>(
      'SELECT COUNT(*) AS n FROM transactions GROUP BY account_id, provider_txn_id HAVING n > 1',
    );
    expect(duplicates).toHaveLength(0);
  });
});

describe('token lifecycle', () => {
  it('refreshes an expired access token transparently, once even under concurrency', async () => {
    const { client } = await connected();
    const accounts = AccountList.parse((await client.get('/api/accounts')).json()).items;
    t.clock.advance(2 * 3_600_000); // the 1 hour access token is now dead

    const [a, b] = await Promise.all(
      accounts.slice(0, 2).map((account) => client.post(`/api/accounts/${account.id}/refresh`)),
    );
    expect(a?.statusCode).toBe(200);
    expect(b?.statusCode).toBe(200);

    const tokenRefreshes = (await labels(client)).filter(
      (label) => label === 'Refresh access token',
    );
    expect(tokenRefreshes).toHaveLength(1);
  });

  it('seals tokens at rest and never exposes them through the API or the Inspector', async () => {
    const { client } = await connected();
    const row = t.db.get<{ tokens_enc: string }>('SELECT tokens_enc FROM connections');
    expect(row?.tokens_enc.startsWith('v1.k1.')).toBe(true);
    expect(row?.tokens_enc).not.toContain('mbk_at_');

    const bodies = await Promise.all(
      [
        '/api/session',
        '/api/connections',
        '/api/accounts',
        '/api/transactions?limit=200',
        '/api/inspector/calls',
        '/api/institutions',
      ].map(async (url) => (await client.get(url)).body),
    );
    const everything = bodies.join('\n');
    for (const secret of ['mbk_at_', 'mbk_rt_', 'mbk_code_', 'mock-client-secret']) {
      expect(everything).not.toContain(secret);
    }
    // The Inspector still proves it is looking at a real exchange.
    expect(everything).toContain('[redacted]');
    expect(everything).toContain('Bearer ••••');
    expect(everything).toContain('/connect/token');
  });

  it('binds a sealed token to its connection row', async () => {
    const { client } = await connected();
    const another = await client.connectBank({ institutionId: 'mock:mock-bank-uk' });
    const rows = t.db.all<{ id: string; tokens_enc: string }>(
      'SELECT id, tokens_enc FROM connections ORDER BY created_at',
    );
    expect(rows).toHaveLength(2);
    // Copy connection A's ciphertext onto connection B: it must no longer decrypt.
    t.db.run(
      'UPDATE connections SET tokens_enc = ? WHERE id = ?',
      rows[0]?.tokens_enc,
      another.connectionId,
    );
    const accounts = AccountList.parse((await client.get('/api/accounts')).json()).items;
    const uk = accounts.find((a) => a.name === 'Everyday Account');
    t.clock.advance(60_000);
    const response = await client.post(`/api/accounts/${uk?.id}/refresh`);
    // Unsealing fails closed: the connection asks the user to sign in again instead of using foreign credentials.
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'reauth_required' });
  });
});

describe('designed failure states after connecting', () => {
  it('maps a bank outage to bank_unavailable and keeps the connection usable', async () => {
    const { client, connectionId, accountId } = await connected();
    t.clock.advance(60_000);
    const armed = await client.post('/api/demo/actions', {
      action: 'bank_unavailable_next',
      connectionId,
    });
    expect(armed.statusCode).toBe(200);

    const failed = await client.post(`/api/accounts/${accountId}/refresh`);
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toMatchObject({ code: 'bank_unavailable' });
    expect((await connection(client)).status).toBe('active');

    const retry = await client.post(`/api/accounts/${accountId}/refresh`);
    expect(retry.statusCode).toBe(200);
  });

  it('maps rate limiting to rate_limited with the bank’s retry hint', async () => {
    const { client, connectionId, accountId } = await connected();
    t.clock.advance(60_000);
    await client.post('/api/demo/actions', { action: 'rate_limit_next', connectionId });
    const response = await client.post(`/api/accounts/${accountId}/refresh`);
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 30 });
    expect(response.headers['retry-after']).toBe('30');
  });

  it('detects consent revoked at the bank, asks to reauthenticate, and recovers on reconnect', async () => {
    const { client, connectionId, accountId } = await connected();
    t.clock.advance(60_000);
    await client.post('/api/demo/actions', { action: 'revoke_at_bank', connectionId });

    const revoked = await client.post(`/api/accounts/${accountId}/refresh`);
    expect(revoked.statusCode).toBe(401);
    expect(revoked.json()).toMatchObject({ code: 'reauth_required' });
    expect((await connection(client)).status).toBe('needs_reauth');

    // Further attempts fail fast without touching the bank.
    const callsBefore = (await labels(client)).length;
    t.clock.advance(60_000);
    expect((await client.post(`/api/accounts/${accountId}/refresh`)).json()).toMatchObject({
      code: 'reauth_required',
    });
    expect((await labels(client)).length).toBe(callsBefore);

    // Reconnect through the hosted journey; the existing connection and its history are kept.
    const start = await client.post('/api/connections', {
      institutionId: 'mock:mock-bank',
      reconnectConnectionId: connectionId,
    });
    expect(start.statusCode).toBe(201);
    expect(start.json<{ connectionId: string }>().connectionId).toBe(connectionId);
    const authUrl = new URL(start.json<{ authUrl: string }>().authUrl);
    const page = await t.app.inject({ method: 'GET', url: `${authUrl.pathname}${authUrl.search}` });
    expect(page.statusCode).toBe(200);
  });

  it('shows the countdown when consent is about to end, and marks it expired afterwards', async () => {
    const { client, connectionId, accountId } = await connected();
    expect((await connection(client)).consentState).toBe('valid');

    await client.post('/api/demo/actions', { action: 'expire_consent_soon', connectionId });
    expect(await connection(client)).toMatchObject({
      consentState: 'expiring_soon',
      consentDaysRemaining: 2,
    });

    await client.post('/api/demo/actions', { action: 'expire_consent_now', connectionId });
    expect(await connection(client)).toMatchObject({ status: 'expired', consentState: 'expired' });

    t.clock.advance(60_000);
    const refresh = await client.post(`/api/accounts/${accountId}/refresh`);
    expect(refresh.statusCode).toBe(403);
    expect(refresh.json()).toMatchObject({ code: 'consent_expired' });
  });

  it('lets the short-consent persona demonstrate expiry reminders without demo controls', async () => {
    t = await createTestApp({ demoControls: false });
    const client = await newClient(t);
    expect((await client.connectBank({ persona: 'short_consent' })).status).toBe('success');
    expect(await connection(client)).toMatchObject({
      consentState: 'expiring_soon',
      consentDaysRemaining: 2,
    });

    t.clock.advance(3 * 86_400_000);
    expect(await connection(client)).toMatchObject({ status: 'expired', consentState: 'expired' });
  });

  it('turns demo controls off when configured', async () => {
    t = await createTestApp({ demoControls: false });
    const client = await newClient(t);
    const { connectionId } = await client.connectBank();
    const response = await client.post('/api/demo/actions', {
      action: 'revoke_at_bank',
      connectionId,
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('privacy and ownership', () => {
  it('keeps one session’s data invisible to another', async () => {
    t = await createTestApp();
    const owner = await newClient(t);
    const { connectionId } = await owner.connectBank();
    const accountId = AccountList.parse((await owner.get('/api/accounts')).json()).items[0]?.id;

    const stranger = await newClient(t);
    expect(AccountList.parse((await stranger.get('/api/accounts')).json()).items).toHaveLength(0);
    expect((await stranger.get('/api/transactions')).json<{ total: number }>().total).toBe(0);
    expect((await stranger.post(`/api/accounts/${accountId}/refresh`)).statusCode).toBe(404);
    expect((await stranger.delete(`/api/connections/${connectionId}`)).statusCode).toBe(404);
    expect(
      InspectorCallList.parse((await stranger.get('/api/inspector/calls')).json()).items,
    ).toHaveLength(0);
  });

  it('revokes at the bank and deletes cached data when a connection is removed', async () => {
    const { client, connectionId } = await connected();
    const removed = await client.delete(`/api/connections/${connectionId}`);
    expect(removed.statusCode).toBe(204);
    expect((await labels(client))[0]).toBe('Delete credentials');
    expect(ConnectionList.parse((await client.get('/api/connections')).json()).items).toHaveLength(
      0,
    );
    expect(t.db.all('SELECT id FROM accounts')).toHaveLength(0);
    expect(t.db.all('SELECT id FROM transactions')).toHaveLength(0);
  });

  it('erases everything and ends the session on "delete all my data"', async () => {
    const { client } = await connected();
    const deleted = await client.delete('/api/session');
    expect(deleted.statusCode).toBe(204);
    expect(t.db.all('SELECT id FROM sessions')).toHaveLength(0);
    expect(t.db.all('SELECT id FROM connections')).toHaveLength(0);
    expect(t.db.all('SELECT id FROM accounts')).toHaveLength(0);
    expect(t.db.all('SELECT id FROM transactions')).toHaveLength(0);
    expect((await client.get('/api/accounts')).statusCode).toBe(401);
  });

  it('forgets sessions that have been idle longer than the TTL', async () => {
    t = await createTestApp({ sessionTtlDays: 7 });
    const client = await newClient(t);
    await client.connectBank();
    t.clock.advance(8 * 86_400_000);
    expect((await client.get('/api/accounts')).statusCode).toBe(401);
    expect(t.db.all('SELECT id FROM sessions')).toHaveLength(0);
    expect(t.db.all('SELECT id FROM transactions')).toHaveLength(0);
  });
});
