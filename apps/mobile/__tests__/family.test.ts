/** @jest-environment node */
import { randomBytes } from 'crypto';
import type { ProviderAccount } from '@api/providers/port';
import { buildFamilyView, parseFamilySummary, type FamilySummary } from '@ledger-lens/contracts';
import { MemoryRelayStore, Relay } from '../../relay/src/relay';
import type { Store, TransactionRow } from '../src/data/db';
import {
  cleanRelayUrl,
  deriveFamilyKeys,
  inviteLink,
  parseInvite,
  seal,
  unseal,
  type RandomBytes,
} from '../src/family/crypto';
import type { RelayWire } from '../src/family/relay';
import { Family, familyProblemText } from '../src/family/service';
import type { FamilyKeyring } from '../src/platform/keychain';
import { clockAt, kyiv, openStore } from './helpers';

const random: RandomBytes = (length) => new Uint8Array(randomBytes(length));
const RELAY = 'https://relay.example';

function keyring(): FamilyKeyring & { value: string | null } {
  const ring = {
    value: null as string | null,
    load: () => Promise.resolve(ring.value),
    keep: (secret: string) => {
      ring.value = secret;
      return Promise.resolve();
    },
    drop: () => {
      ring.value = null;
      return Promise.resolve();
    },
  };
  return ring;
}

/** A real relay, in this process: what the phones send is what it stores, and the test can look at both. */
function relayWorld() {
  const store = new MemoryRelayStore();
  const clock = clockAt('2026-11-13T10:00:00Z');
  const relay = new Relay({ store, now: () => clock.now().getTime() });
  const seen: { method: string; url: string; body: Uint8Array | null; headers: string }[] = [];
  let online = true;
  const wire: RelayWire = async (url, init) => {
    if (!online) throw new TypeError('Network request failed');
    seen.push({
      method: init.method,
      url,
      body: init.body ?? null,
      headers: JSON.stringify(init.headers),
    });
    const response = await relay.handle(
      new Request(url, {
        method: init.method,
        headers: init.headers,
        body: init.body ? Uint8Array.from(init.body) : undefined,
      }),
      'phone',
    );
    return { status: response.status, text: () => response.text() };
  };
  return { store, wire, seen, clock, setOnline: (value: boolean) => (online = value) };
}

async function phone(world: ReturnType<typeof relayWorld>) {
  const store = await openStore();
  const ring = keyring();
  const family = new Family(store, ring, world.wire, world.clock, kyiv(), random);
  return { store, ring, family };
}

const card = (over: Partial<ProviderAccount> = {}): ProviderAccount => ({
  providerAccountId: 'card',
  kind: 'card',
  cardType: 'black',
  name: 'Black',
  currency: 'UAH',
  last4: '4321',
  creditLimitMinor: 0,
  balanceMinor: 12_000_00,
  goalMinor: null,
  sort: 0,
  ...over,
});

const txn = (id: string, over: Partial<TransactionRow>): TransactionRow => ({
  id,
  accountId: 'card',
  ts: Date.parse('2026-11-05T09:00:00Z'),
  status: 'booked',
  amountMinor: -100_00,
  currency: 'UAH',
  description: 'Таємна крамниця',
  counterparty: 'Секретний Отримувач',
  comment: null,
  mcc: null,
  category: 'groceries',
  ...over,
});

async function connectBank(store: Store, rows: TransactionRow[], account = card()): Promise<void> {
  await store.replaceAccounts([account]);
  await store.upsertTransactions(rows);
  await store.setMeta('connected', 'live');
}

describe('sealing a summary', () => {
  const keys = deriveFamilyKeys(random(32));

  it('opens again with the same family and person, Ukrainian text and all', () => {
    const text = JSON.stringify({ name: 'Ганна', spent: 1 });
    expect(unseal(keys, 'aa'.repeat(8), seal(keys, 'aa'.repeat(8), text, random))).toBe(text);
  });

  it('does not open for another family, another person, or after one changed byte', () => {
    const blob = seal(keys, 'aa'.repeat(8), '{"a":1}', random);
    expect(unseal(deriveFamilyKeys(random(32)), 'aa'.repeat(8), blob)).toBeNull();
    expect(unseal(keys, 'bb'.repeat(8), blob)).toBeNull();
    const changed = Uint8Array.from(blob);
    changed[40] = (changed[40] ?? 0) ^ 1;
    expect(unseal(keys, 'aa'.repeat(8), changed)).toBeNull();
    expect(unseal(keys, 'aa'.repeat(8), new Uint8Array(10))).toBeNull();
  });

  it('never seals the same text to the same bytes, and hides its length', () => {
    const a = seal(keys, 'aa'.repeat(8), '{"a":1}', random);
    const b = seal(keys, 'aa'.repeat(8), '{"a":1}', random);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(a.length).toBe(seal(keys, 'aa'.repeat(8), `{"a":"${'x'.repeat(500)}"}`, random).length);
  });

  it('gives the relay an id and a key that are not the secret or the encryption key', () => {
    const secret = random(32);
    const derived = deriveFamilyKeys(secret);
    expect(derived.familyId).toMatch(/^[0-9a-f]{32}$/);
    expect(derived.accessKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
    expect(hex(derived.encryptionKey)).not.toBe(hex(secret));
    expect(Buffer.from(derived.accessKey, 'base64url').toString('hex')).not.toBe(
      hex(derived.encryptionKey),
    );
    expect(deriveFamilyKeys(secret)).toEqual(derived);
  });
});

describe('an invitation', () => {
  it('comes back from its link, also from the middle of a pasted message', () => {
    const secret = random(32);
    const link = inviteLink({ secret, relayUrl: RELAY });
    expect(link.startsWith('ledgerlens://family#v1.')).toBe(true);
    const parsed = parseInvite(`Ось запрошення: ${link} — відкрий на телефоні`);
    expect(parsed?.relayUrl).toBe(RELAY);
    expect(Buffer.from(parsed?.secret ?? []).equals(Buffer.from(secret))).toBe(true);
  });

  it('is refused when it is something else, or points at a relay without HTTPS', () => {
    expect(parseInvite('hello')).toBeNull();
    expect(parseInvite('ledgerlens://family#v1.short.abc')).toBeNull();
    const plain = inviteLink({ secret: random(32), relayUrl: 'http://relay.example' });
    expect(parseInvite(plain)).toBeNull();
    expect(cleanRelayUrl('https://relay.example/')).toBe(RELAY);
    expect(cleanRelayUrl('http://relay.example')).toBeNull();
    expect(cleanRelayUrl('https://relay.example/?x=1')).toBeNull();
    expect(cleanRelayUrl('https://user:pw@relay.example')).toBeNull();
  });
});

describe('a family of two phones', () => {
  async function family() {
    const world = relayWorld();
    const anna = await phone(world);
    const borys = await phone(world);
    await connectBank(anna.store, [
      txn('a1', { amountMinor: -400_00, category: 'groceries' }),
      txn('a2', { amountMinor: -150_00, category: 'dining' }),
      txn('a3', { amountMinor: 50_00, category: 'groceries' }), // a refund
      txn('a4', { amountMinor: -900_00, category: 'transfers' }), // not spending
      txn('a5', { amountMinor: 30_000_00, category: 'income' }),
      txn('a6', { amountMinor: -70_00, category: 'transport', status: 'pending' }),
      txn('a7', { amountMinor: -200_00, ts: Date.parse('2026-10-20T09:00:00Z') }),
    ]);
    await connectBank(borys.store, [txn('b1', { amountMinor: -250_00, category: 'transport' })]);
    await anna.family.start('Ганна', RELAY);
    await borys.family.join((await anna.family.invitation()) ?? '', '  Борис  ');
    await anna.family.refresh();
    return { world, anna, borys };
  }

  it('each sees the month of both: spending by person and category, by the rules of Insights', async () => {
    const { anna, borys } = await family();
    for (const each of [anna, borys]) {
      const state = await each.family.state();
      const view = buildFamilyView(state.summaries, '2026-11');
      expect(view.members.map((m) => [m.name, m.spentMinor])).toEqual([
        ['Ганна', 500_00], // 400 - 50 refund + 150; the transfer and the pending row are not in it
        ['Борис', 250_00],
      ]);
      expect(view.spentMinor).toBe(750_00);
      expect(view.incomeMinor).toBe(30_000_00);
      expect(view.categories.map((c) => [c.category, c.spentMinor])).toEqual([
        ['groceries', 350_00],
        ['transport', 250_00],
        ['dining', 150_00],
      ]);
      expect(buildFamilyView(state.summaries, '2026-10').spentMinor).toBe(200_00);
    }
  });

  it('money is shared only by those who choose to', async () => {
    const { anna, borys } = await family();
    let view = buildFamilyView((await borys.family.state()).summaries, '2026-11');
    expect([view.balancesShared, view.balancesHidden, view.balanceMinor]).toEqual([0, 2, 0]);
    await anna.family.setShareBalance(true);
    await borys.family.refresh();
    view = buildFamilyView((await borys.family.state()).summaries, '2026-11');
    expect([view.balancesShared, view.balancesHidden, view.balanceMinor]).toEqual([
      1, 1, 12_000_00,
    ]);
  });

  it('a budget set on one phone reaches the other and stays when its author leaves', async () => {
    const { world, anna, borys } = await family();
    world.clock.advance(60_000);
    await anna.family.setBudget(1_000_00);
    await borys.family.refresh();
    let view = buildFamilyView((await borys.family.state()).summaries, '2026-11');
    expect(view.budget).toEqual({
      monthlyMinor: 1_000_00,
      leftMinor: 250_00,
      usedPercent: 75,
      setBy: 'Ганна',
    });
    await anna.family.leave();
    await borys.family.refresh();
    view = buildFamilyView((await borys.family.state()).summaries, '2026-11');
    expect(view.members.map((m) => m.name)).toEqual(['Борис']);
    expect(view.budget?.monthlyMinor).toBe(1_000_00);
    world.clock.advance(60_000);
    await borys.family.setBudget(0);
    expect(buildFamilyView((await borys.family.state()).summaries, '2026-11').budget).toBeNull();
  });

  it('the relay sees sealed bytes only: no name, figure, merchant or secret, and no bank token', async () => {
    const { world, anna } = await family();
    await anna.family.setShareBalance(true);
    const secret = anna.ring.value ?? '';
    const stored = world.store
      .members(deriveFamilyKeys(Uint8Array.from(Buffer.from(secret, 'base64url'))).familyId)
      .map((member) => Buffer.from(member.blob).toString('latin1'));
    const sent = world.seen.map(
      (call) => `${call.url} ${call.headers} ${Buffer.from(call.body ?? []).toString('latin1')}`,
    );
    for (const text of [...stored, ...sent]) {
      for (const word of ['Ганна', 'Борис', 'groceries', 'spentMinor', '50000', 'Таємна', secret]) {
        expect(text.includes(word)).toBe(false);
        expect(text.includes(Buffer.from(word, 'utf8').toString('latin1'))).toBe(false);
      }
    }
    expect(world.seen.every((call) => call.url.startsWith(`${RELAY}/v1/families/`))).toBe(true);
  });

  it('what a phone shares holds totals only: no description, counterparty, account or card digits', async () => {
    const { anna } = await family();
    await anna.family.setShareBalance(true);
    const shared = JSON.stringify((await anna.family.state()).summaries);
    for (const word of ['Таємна', 'Секретний', '4321', 'Black', 'card', 'a1']) {
      expect(shared).not.toContain(word);
    }
  });

  it('a phone with no bank, or the demo, watches and shares no figures', async () => {
    const { world, anna } = await family();
    const watcher = await phone(world);
    await watcher.store.replaceAccounts([card()]);
    await watcher.store.upsertTransactions([txn('d1', { amountMinor: -999_00 })]);
    await watcher.store.setMeta('connected', 'demo');
    await watcher.family.join((await anna.family.invitation()) ?? '', 'Дід');
    const mine = (await watcher.family.state()).summaries.find((s) => s.name === 'Дід');
    expect(mine).toMatchObject({ balanceMinor: null, months: [] });
    expect(buildFamilyView((await watcher.family.state()).summaries, '2026-11').spentMinor).toBe(
      750_00,
    );
  });

  it('disconnecting the bank keeps the family; leaving forgets it and frees the Keychain', async () => {
    const { anna } = await family();
    await anna.store.clearBank();
    expect((await anna.family.state()).joined).toBe(true);
    await anna.family.leave();
    expect((await anna.family.state()).joined).toBe(false);
    expect(anna.ring.value).toBeNull();
    expect(await anna.store.meta('family.cache')).toBeNull();
  });
});

describe('joining and starting, when something is wrong', () => {
  it('explains a bad invitation, a missing name and an address without HTTPS, and keeps nothing', async () => {
    const world = relayWorld();
    const anna = await phone(world);
    const text = async (task: Promise<void>): Promise<string> =>
      task.then(
        () => 'no problem',
        (error: unknown) => familyProblemText(error),
      );
    expect(await text(anna.family.join('nothing here', 'Ганна'))).toMatch(/not a Ledger Lens/);
    expect(await text(anna.family.start(' ', RELAY))).toMatch(/name/);
    expect(await text(anna.family.start('Ганна', 'http://relay.example'))).toMatch(/https/);
    world.setOnline(false);
    expect(await text(anna.family.start('Ганна', RELAY))).toMatch(/did not answer/);
    expect((await anna.family.state()).joined).toBe(false);
    expect(anna.ring.value).toBeNull();
    expect(world.seen).toHaveLength(0);
  });

  it('a summary that is not what the app describes is counted, not shown', async () => {
    const world = relayWorld();
    const anna = await phone(world);
    await anna.family.start('Ганна', RELAY);
    const keys = deriveFamilyKeys(Uint8Array.from(Buffer.from(anna.ring.value ?? '', 'base64url')));
    const odd = 'cc'.repeat(8);
    // Sealed with the family's key, but claiming to be someone else, and one that is not a summary at all.
    const forged = { ...(await anna.family.state()).summaries[0], name: 'Хтось' };
    world.store.putMember(keys.familyId, odd, seal(keys, odd, JSON.stringify(forged), random), 1);
    const junk = 'dd'.repeat(8);
    world.store.putMember(keys.familyId, junk, seal(keys, junk, '{"v":99}', random), 1);
    await anna.family.refresh();
    const state = await anna.family.state();
    expect(state.summaries.map((s) => s.name)).toEqual(['Ганна']);
    expect(state.unreadable).toBe(2);
  });
});

describe('a summary from another phone', () => {
  const good: FamilySummary = {
    v: 1,
    memberId: 'ab'.repeat(8),
    name: 'Ганна',
    updatedAt: 1,
    balanceMinor: null,
    months: [{ month: '2026-11', spentMinor: 5, incomeMinor: 0, byCategory: { dining: 5 } }],
    budget: null,
  };

  it('is taken as it is when it is well-formed', () => {
    expect(parseFamilySummary(JSON.parse(JSON.stringify(good)))).toEqual(good);
  });

  it.each([
    ['a float', { months: [{ ...good.months[0], spentMinor: 1.5 }] }],
    ['a negative amount', { months: [{ ...good.months[0], spentMinor: -1 }] }],
    ['a text amount', { balanceMinor: '5' }],
    ['a strange month', { months: [{ ...good.months[0], month: 'November' }] }],
    ['a strange id', { memberId: '../x' }],
    ['another version', { v: 2 }],
  ])('is refused whole with %s', (_what, change) => {
    expect(parseFamilySummary({ ...good, ...change })).toBeNull();
  });
});
