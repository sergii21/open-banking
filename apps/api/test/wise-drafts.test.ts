import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { WiseDraftOverview, WiseDraftQuote } from '@ledger-lens/contracts';
import { fixedClock } from '../src/clock';
import { DiagnosticsCollector } from '../src/domain/diagnostics';
import { EventBus } from '../src/modules/events/event-bus';
import { InspectorStore } from '../src/modules/inspector/inspector-store';
import { TokenRejectedError } from '../src/providers/port';
import { WISE_WRITE_PATHS, WiseProvider } from '../src/providers/wise/adapter';
import { FAKE_WISE_PROFILE_ID, type FakeWise } from '../src/providers/wise/demo/fake';
import { ProviderHttp, type Transport } from '../src/providers/transport';
import { Client, FAKE_WISE_TOKEN, NOW, createTestApp, pauseOn, wise } from './helpers';

const EUR_RECIPIENT = 700002;

async function connected(setup: (fake: FakeWise) => void = () => undefined) {
  const clock = fixedClock(NOW);
  const fake = wise(clock);
  setup(fake);
  const t = await createTestApp(
    {},
    { clock, transports: { wise: fake.transport, pause: pauseOn(clock) } },
  );
  const client = new Client(t);
  await client.start();
  const response = await client.post('/api/connection', {
    mode: 'token',
    provider: 'wise',
    token: FAKE_WISE_TOKEN,
  });
  expect(response.statusCode).toBe(201);
  const overview = async (): Promise<WiseDraftOverview> =>
    (await client.get('/api/wise/drafts')).json<WiseDraftOverview>();
  const first = await overview();
  const eur = first.sources.find((s) => s.currency === 'EUR');
  if (!eur) throw new Error('no EUR balance');
  const quote = (amountMinor = 10_000) =>
    client.post('/api/wise/drafts/quote', {
      accountId: eur.accountId,
      recipientId: EUR_RECIPIENT,
      targetCurrency: 'EUR',
      amountMinor,
    });
  const create = (q: WiseDraftQuote, reference?: string) =>
    client.post('/api/wise/drafts', {
      accountId: eur.accountId,
      recipientId: EUR_RECIPIENT,
      quoteId: q.quoteId,
      draftKey: q.draftKey,
      ...(reference ? { reference } : {}),
    });
  return { t, client, fake, overview, first, eur, quote, create };
}

const writesOf = (fake: FakeWise): string[] =>
  fake.requests.filter((r) => r.method !== 'GET').map((r) => `${r.method} ${r.path}`);

describe('Wise draft transfers', () => {
  it('prices a transfer, creates it unpaid, and never asks Wise to fund it', async () => {
    const { t, fake, overview, first, eur, quote, create } = await connected();
    try {
      // Balances only, no jar; a closed recipient is not offered.
      expect(first.sources.map((s) => s.currency)).toEqual(['EUR', 'USD', 'GBP']);
      expect(first.recipients.map((r) => r.name)).toEqual(['Olena Vigada', 'Taras Made-Up']);
      expect(first.waiting).toEqual([]);
      expect(writesOf(fake)).toEqual([]);

      const priced = await quote();
      expect(priced.statusCode).toBe(200);
      const q = priced.json<WiseDraftQuote>();
      expect(q).toMatchObject({
        sourceMinor: 10_000,
        sourceCurrency: eur.currency,
        targetMinor: 9_950,
        targetCurrency: 'EUR',
        feeMinor: 50,
        fromBalance: true,
      });
      // Pricing creates nothing.
      expect((await overview()).waiting).toEqual([]);

      const created = await create(q, 'November rent');
      expect(created.statusCode).toBe(201);
      const waiting = (await overview()).waiting;
      expect(waiting).toHaveLength(1);
      // The amount comes from what the recipient gets: Wise's own source value reads 0 until the transfer is paid.
      expect(waiting[0]).toMatchObject({
        targetMinor: 9_950,
        targetCurrency: 'EUR',
        recipientName: 'Taras Made-Up',
      });

      expect(writesOf(fake)).toEqual([
        `POST /2026Q4/profiles/${FAKE_WISE_PROFILE_ID}/quotes`,
        'POST /2026Q4/transfers',
      ]);
      expect(fake.requests.some((r) => r.path.includes('payments'))).toBe(false);
    } finally {
      await t.close();
    }
  });

  it('creates one transfer when the same draft is sent twice', async () => {
    const { t, overview, quote, create } = await connected();
    try {
      const q = (await quote()).json<WiseDraftQuote>();
      const once = await create(q);
      const twice = await create(q);
      expect(twice.statusCode).toBe(201);
      expect(twice.json()).toEqual(once.json());
      expect((await overview()).waiting).toHaveLength(1);
    } finally {
      await t.close();
    }
  });

  it('keeps amounts exact', async () => {
    const { t, quote } = await connected();
    try {
      const q = (await quote(1_999)).json<WiseDraftQuote>();
      expect(q.sourceMinor).toBe(1_999);
      expect(Number.isInteger(q.targetMinor)).toBe(true);
    } finally {
      await t.close();
    }
  });

  it('a token that may not write is explained, and the connection keeps working for balances', async () => {
    const { t, client, fake, quote } = await connected();
    try {
      fake.writesForbidden = true;
      const refused = await quote();
      expect(refused.statusCode).toBe(502);
      expect(refused.json().detail).toMatch(/does not let this token/);
      const session = (await client.get('/api/session')).json<{
        connections: { status: string }[];
      }>();
      expect(session.connections[0]?.status).toBe('active');
      expect((await client.get('/api/home')).statusCode).toBe(200);
    } finally {
      await t.close();
    }
  });

  it('passes on what Wise says when it refuses, such as a missing payment approval', async () => {
    const { t, fake, quote, create } = await connected();
    try {
      const q = (await quote()).json<WiseDraftQuote>();
      fake.needsApproval = true;
      const refused = await create(q);
      expect(refused.statusCode).toBe(502);
      expect(refused.json().detail).toBe(
        'Wise refused this: Quote cannot be accepted with this request due to missing approval',
      );
    } finally {
      await t.close();
    }
  });

  it('takes the profile from an account in this session, never from the browser', async () => {
    const { t, client, first } = await connected();
    try {
      const unknown = await client.post('/api/wise/drafts/quote', {
        accountId: 'not-an-account',
        recipientId: EUR_RECIPIENT,
        targetCurrency: 'EUR',
        amountMinor: 100,
      });
      expect(unknown.statusCode).toBe(404);
      const stranger = new Client(t);
      await stranger.start();
      const theirs = await stranger.get(`/api/wise/drafts?accountId=${first.accountId}`);
      expect(theirs.statusCode).toBe(404);
    } finally {
      await t.close();
    }
  });

  it('refuses a draft with no CSRF token and a bad amount', async () => {
    const { t, client, eur } = await connected();
    try {
      for (const amountMinor of [0, -5, 1.5]) {
        const response = await client.post('/api/wise/drafts/quote', {
          accountId: eur.accountId,
          recipientId: EUR_RECIPIENT,
          targetCurrency: 'EUR',
          amountMinor,
        });
        expect(response.statusCode).toBe(400);
      }
      const noHeader = await t.app.inject({
        method: 'POST',
        url: '/api/wise/drafts/quote',
        payload: {
          accountId: eur.accountId,
          recipientId: 1,
          targetCurrency: 'EUR',
          amountMinor: 1,
        },
      });
      expect(noHeader.statusCode).toBeGreaterThanOrEqual(400);
    } finally {
      await t.close();
    }
  });

  it('reads at most three pages of recipients and says when there are more', async () => {
    const { t, first } = await connected((fake) => {
      fake.extraRecipients = 100;
    });
    try {
      expect(first.recipients).toHaveLength(59);
      expect(first.moreRecipients).toBe(true);
    } finally {
      await t.close();
    }
  });

  it('keeps recipients, references and ids out of the Live API drawer and diagnostics', async () => {
    const { t, client, quote, create } = await connected();
    try {
      const q = (await quote()).json<WiseDraftQuote>();
      await create(q, 'November rent');
      const calls = (await client.get('/api/inspector/calls')).payload;
      expect(calls).toContain('Create a draft transfer');
      for (const secret of [
        FAKE_WISE_TOKEN,
        String(FAKE_WISE_PROFILE_ID),
        'Taras',
        'Olena',
        '12345678',
        'BE68',
        'November rent',
        String(EUR_RECIPIENT),
        q.draftKey,
      ]) {
        expect(calls).not.toContain(secret);
      }
      const diagnostics = (await client.get('/api/diagnostics')).json<{ text: string }>().text;
      for (const secret of ['Taras', 'Olena', '12345678', 'November rent', q.draftKey]) {
        expect(diagnostics).not.toContain(secret);
      }
    } finally {
      await t.close();
    }
  });
});

describe('the Wise adapter cannot pay', () => {
  function rig(transport?: Transport) {
    const clock = fixedClock(NOW);
    const fake = wise(clock);
    const provider = new WiseProvider({
      id: 'wise',
      mode: 'live',
      label: 'Wise',
      http: new ProviderHttp({
        provider: 'wise',
        mode: 'live',
        transport: transport ?? fake.transport,
        inspector: new InspectorStore(new EventBus()),
        clock,
      }),
      apiUrl: 'https://api.wise.test/2026Q4',
      limits: {
        statementIntervalMs: 1000,
        infoIntervalMs: 1000,
        maxWindowDays: 31,
        maxItemsPerCall: Number.MAX_SAFE_INTEGER,
        historyMonths: 1,
        sharedLimit: true,
        balancesOnly: true,
      },
      clock,
      diagnostics: new DiagnosticsCollector(),
      pause: pauseOn(clock),
    });
    return { fake, provider };
  }
  const CTX = { sessionId: 'ses_test', connectionId: null };
  const TOKENS = { accessToken: FAKE_WISE_TOKEN };
  const answer =
    (status: number, headers: Record<string, string> = {}): Transport =>
    () =>
      Promise.resolve(new Response('{}', { status, headers }));

  it('allows exactly two writes, and neither is the one that funds a transfer', () => {
    expect(WISE_WRITE_PATHS).toHaveLength(2);
    const allowed = (path: string) => WISE_WRITE_PATHS.some((p) => p.test(path));
    expect(allowed('/profiles/1/quotes')).toBe(true);
    expect(allowed('/transfers')).toBe(true);
    for (const path of [
      '/profiles/1/transfers/2/payments',
      '/v3/profiles/1/transfers/2/payments',
      '/transfers/2/cancel',
      '/transfers/2/payments',
      '/accounts',
      '/profiles/1/quotes/../transfers/2/payments',
    ]) {
      expect(allowed(path)).toBe(false);
    }
  });

  it('refuses any other write before it reaches the network', async () => {
    const { fake, provider } = rig();
    const post = (
      provider as unknown as {
        post(...args: unknown[]): Promise<unknown>;
      }
    ).post.bind(provider);
    await expect(
      post(TOKENS, CTX, 'x', 'x', `/profiles/${FAKE_WISE_PROFILE_ID}/transfers/1/payments`, {
        type: 'BALANCE',
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(fake.requests).toEqual([]);
  });

  it('has no funding path anywhere in its source', () => {
    const source = readFileSync(
      new URL('../src/providers/wise/adapter.ts', import.meta.url),
      'utf8',
    );
    const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(code).not.toMatch(/payments/i);
  });

  it('a refusal on a draft call never reads as a rejected token, except a real 401', async () => {
    const plain = rig(answer(403));
    await expect(plain.provider.listRecipients(TOKENS, CTX, 1)).rejects.toMatchObject({
      code: 'provider_error',
    });
    const sca = rig(answer(403, { 'x-2fa-approval': 'one-time' }));
    await expect(sca.provider.listWaiting(TOKENS, CTX, 1)).rejects.toMatchObject({
      code: 'provider_error',
      message: expect.stringMatching(/never signs requests/) as string,
    });
    const gone = rig(answer(401));
    await expect(gone.provider.listRecipients(TOKENS, CTX, 1)).rejects.toBeInstanceOf(
      TokenRejectedError,
    );
    const limited = rig(answer(429, { 'retry-after': '7' }));
    await expect(limited.provider.listRecipients(TOKENS, CTX, 1)).rejects.toMatchObject({
      code: 'rate_limited',
      retryAfterSeconds: 7,
    });
    const down = rig(answer(503));
    await expect(down.provider.listRecipients(TOKENS, CTX, 1)).rejects.toMatchObject({
      code: 'bank_unavailable',
    });
  });

  it('reports a transfer as created when Wise said yes in an answer it cannot read', async () => {
    const { provider } = rig(answer(200));
    await expect(
      provider.createDraft(TOKENS, CTX, {
        recipientId: 1,
        quoteId: 'q',
        key: 'k',
        reference: null,
      }),
    ).resolves.toEqual({ transferId: null, status: null });
  });
});
