import { AppError } from '@api/errors';
import { FakeMonobank } from '@api/providers/monobank/demo/fake';
import type { Wire } from '../src/bank/http';
import { MONOBANK_API, MONOBANK_LIMITS, demoBank, fakeWire, liveBank } from '../src/bank/provider';
import { Sync } from '../src/bank/sync';
import { buildOverview } from '../src/model/overview';
import { clockAt, kyiv, memoryVault, openStore } from './helpers';

const TOKEN = 'uRealLookingTokenForTheFakeBank_0123456789';
const MINUTE = 60_000;

/** The app on the paced fake of api.monobank.ua: one read a minute per endpoint, as the real bank. */
async function setup(options: { shared?: boolean } = {}) {
  const clock = clockAt();
  const calendar = kyiv();
  const fake = new FakeMonobank({
    clock,
    calendar,
    token: TOKEN,
    limits: { statementMs: MINUTE, infoMs: MINUTE, shared: options.shared },
  });
  const seen: { url: string; method: string; headers: Record<string, string> }[] = [];
  const inner = fakeWire(fake, MONOBANK_API);
  const wire: Wire = (url, init) => {
    seen.push({ url, method: init.method, headers: init.headers });
    return inner(url, init);
  };
  const store = await openStore();
  const vault = memoryVault();
  const sync = new Sync(liveBank(clock, calendar, wire), store, vault, clock, calendar);
  const statements = () => seen.filter((call) => call.url.includes('/personal/statement/')).length;
  return { clock, calendar, fake, seen, store, vault, sync, statements };
}

describe('connecting on the phone', () => {
  it('a token monobank does not know is explained, not kept, and not repeated in the message', async () => {
    const { sync, vault, store } = await setup();
    const wrong = 'uWrongTokenWrongTokenWrongToken_987654321';
    const error = await sync.connect(wrong).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    const shown = JSON.stringify([(error as AppError).message, (error as AppError).errors]);
    expect(shown).toContain('monobank does not recognise this token');
    expect(shown).not.toContain(wrong);
    expect(vault.value).toBeNull();
    expect(await store.accounts()).toEqual([]);
    expect(sync.current.status).toBe('not-connected');
  });

  it('something that is not a token is refused without a request', async () => {
    const { sync, seen } = await setup();
    await expect(sync.connect('not a token')).rejects.toMatchObject({ code: 'validation_failed' });
    expect(seen).toHaveLength(0);
  });

  it('a good token goes to the Keychain, balances are there at once and the history is planned', async () => {
    const { sync, vault, store, seen } = await setup();
    await sync.connect(`  ${TOKEN}\n`);
    expect(vault.value).toBe(TOKEN);
    expect(seen).toHaveLength(1);
    const accounts = await store.accounts();
    expect(accounts.length).toBeGreaterThan(1);
    const cards = accounts.filter((a) => a.kind === 'card').length;
    const counts = await store.windowCounts();
    expect(counts.done).toBe(0);
    expect(counts.total % cards).toBe(0);
    expect(counts.total / cards).toBeGreaterThanOrEqual(3);
    expect(sync.current).toMatchObject({
      status: 'waiting',
      demo: false,
      windowsTotal: counts.total,
    });
    // The token is in no table of the database.
    expect(JSON.stringify([accounts, await store.meta('connected')])).not.toContain(TOKEN);
  });
});

describe('reading at the bank’s pace', () => {
  it('one statement a minute, never a 429, until everything is read', async () => {
    const { sync, clock, store, statements, seen } = await setup();
    await sync.connect(TOKEN);
    const total = (await store.windowCounts()).total;

    // The first statement goes out at once; asking again inside the minute sends nothing and says how long to wait.
    await sync.step(); // public rates, then the first statement
    expect(statements()).toBe(1);
    const wait = await sync.step();
    expect(statements()).toBe(1);
    expect(wait).toBeGreaterThan(MINUTE - 1_000);
    expect(wait).toBeLessThanOrEqual(MINUTE);
    expect(sync.current.status).toBe('waiting');
    expect(sync.current.nextAt).toBe(clock.now().getTime() + (wait ?? 0));

    for (let guard = 0; guard < 500 && sync.current.status !== 'up-to-date'; guard++) {
      const ms = await sync.step();
      expect(ms).not.toBeNull();
      clock.advance(ms ?? 0);
    }
    expect(sync.current.status).toBe('up-to-date');
    expect(statements()).toBe(total);
    expect(await store.transactionCount()).toBeGreaterThan(50);
    expect(await store.meta('blockedUntil')).toBeNull();

    // Read-only, and the token went to monobank and nowhere else.
    expect(seen.every((call) => call.method === 'GET')).toBe(true);
    expect(seen.every((call) => call.url.startsWith(`${MONOBANK_API}/`))).toBe(true);
    expect(
      seen.filter((c) => c.url.endsWith('/bank/currency')).every((c) => !c.headers['x-token']),
    ).toBe(true);
  });

  it('the newest month of every card comes before older months', async () => {
    const { sync, store } = await setup();
    await sync.connect(TOKEN);
    const cards = (await store.accounts()).filter((a) => a.kind === 'card');
    const firsts: string[] = [];
    for (let i = 0; i < cards.length; i++) {
      const next = await store.nextWindow();
      if (!next) break;
      firsts.push(next.accountId);
      await store.finishWindow(next.id);
    }
    expect(firsts).toEqual(cards.map((card) => card.providerAccountId));
  });

  it('a 429 because the computer used the minute is a wait, not an error, and the read is tried again', async () => {
    const { sync, clock, fake, statements, store } = await setup();
    await sync.connect(TOKEN);
    const card = (await store.accounts())[0];
    const now = Math.floor(clock.now().getTime() / 1000);
    // The person's computer reads a statement with the same token just before the phone does.
    expect(
      fake.handle(
        'GET',
        `/personal/statement/${card?.providerAccountId}/${now - 3600}/${now}`,
        TOKEN,
      ).status,
    ).toBe(200);
    const wait = await sync.step();
    expect(statements()).toBe(1);
    expect(sync.current.status).toBe('waiting');
    expect(wait).toBe(MINUTE);
    expect((await store.windowCounts()).done).toBe(0);
    clock.advance(wait ?? 0);
    await sync.step();
    expect(statements()).toBe(2);
    expect((await store.windowCounts()).done).toBe(1);
  });

  it('a bank that is down is tried again later and nothing is lost', async () => {
    const { sync, clock, fake, store } = await setup();
    await sync.connect(TOKEN);
    fake.down = true;
    expect(await sync.step()).toBe(MINUTE);
    expect(sync.current.status).toBe('bank-down');
    fake.down = false;
    clock.advance(MINUTE);
    await sync.step();
    expect((await store.windowCounts()).done).toBe(1);
  });

  it('a token replaced at the bank stops the reading and asks for a new one; the old data stays', async () => {
    const { sync, clock, calendar, store, vault } = await setup();
    await sync.connect(TOKEN);
    await sync.step();
    const had = await store.transactionCount();
    // monobank now knows a different token.
    const other = new FakeMonobank({ clock, calendar, token: 'another-token-entirely-0000000000' });
    const replaced = new Sync(
      liveBank(clock, calendar, fakeWire(other, MONOBANK_API)),
      store,
      vault,
      clock,
      calendar,
    );
    await replaced.resume();
    clock.advance(MINUTE);
    expect(await replaced.step()).toBeNull();
    expect(replaced.current.status).toBe('needs-token');
    expect(await store.transactionCount()).toBe(had);
    // And it stays that way the next time the app opens.
    await replaced.resume();
    expect(replaced.current.status).toBe('needs-token');
  });

  it('a refresh reads balances and the last days again, once', async () => {
    const { sync, clock, store, seen } = await setup();
    await sync.connect(TOKEN);
    for (let guard = 0; guard < 500 && sync.current.status !== 'up-to-date'; guard++) {
      clock.advance((await sync.step()) ?? 0);
    }
    const cards = (await store.accounts()).filter((a) => a.kind === 'card').length;
    const before = seen.length;
    await sync.refresh();
    await sync.refresh();
    expect(await store.windowCounts()).toEqual({ done: 0, total: cards });
    clock.advance(MINUTE);
    for (let guard = 0; guard < 50 && sync.current.status !== 'up-to-date'; guard++) {
      clock.advance((await sync.step()) ?? 0);
    }
    const after = seen.slice(before);
    expect(after.filter((c) => c.url.endsWith('/personal/client-info'))).toHaveLength(1);
    expect(after.filter((c) => c.url.includes('/personal/statement/'))).toHaveLength(cards);
  });

  it('disconnecting forgets the token and the bank’s data', async () => {
    const { sync, store, vault } = await setup();
    await sync.connect(TOKEN);
    await sync.step();
    await sync.disconnect();
    expect(vault.value).toBeNull();
    expect(await store.accounts()).toEqual([]);
    expect(await store.transactionCount()).toBe(0);
    expect(await sync.step()).toBeNull();
  });

  it('the phone asks for three months, 31 days at a time', () => {
    expect(MONOBANK_LIMITS).toMatchObject({
      historyMonths: 3,
      maxWindowDays: 31,
      maxItemsPerCall: 500,
    });
  });
});

describe('the demo', () => {
  it('runs the same adapter on made-up data with no network and no Keychain', async () => {
    const realFetch = globalThis.fetch;
    const fetched = jest.fn(() => Promise.reject(new Error('the demo must not use the network')));
    globalThis.fetch = fetched;
    try {
      const clock = clockAt();
      const calendar = kyiv();
      const store = await openStore();
      const vault = memoryVault();
      const sync = new Sync(demoBank(clock, calendar), store, vault, clock, calendar);
      await sync.connect('');
      for (let guard = 0; guard < 500 && sync.current.status !== 'up-to-date'; guard++) {
        clock.advance((await sync.step()) ?? 0);
      }
      expect(sync.current).toMatchObject({ status: 'up-to-date', demo: true });
      expect(fetched).not.toHaveBeenCalled();
      expect(vault.value).toBeNull();

      const overview = buildOverview(await store.accounts(), await store.rates());
      expect(overview.totalUahMinor).toBeGreaterThan(0);
      expect(Number.isInteger(overview.totalUahMinor)).toBe(true);
      expect(overview.unvalued).toBe(0);
      const rows = await store.transactions('', 1000);
      expect(rows.length).toBeGreaterThan(100);
      expect(rows.every((row) => Number.isInteger(row.amountMinor))).toBe(true);
      const word = rows[0]?.description.split(' ')[0] ?? '';
      expect((await store.transactions(word.toUpperCase(), 10)).length).toBeGreaterThan(0);

      // The next time the app opens, the demo is still the demo.
      const again = new Sync(demoBank(clock, calendar), store, vault, clock, calendar);
      await again.resume();
      expect(again.current.status).toBe('waiting');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
