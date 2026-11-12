import type { ProviderAccount } from '@api/providers/port';
import { Store, type TransactionRow } from '../src/data/db';
import { memoryDb, openStore } from './helpers';

const account = (id: string, over: Partial<ProviderAccount> = {}): ProviderAccount => ({
  providerAccountId: id,
  kind: 'card',
  cardType: 'black',
  name: 'Black',
  currency: 'UAH',
  last4: '1234',
  creditLimitMinor: 0,
  balanceMinor: 100_00,
  goalMinor: null,
  sort: 0,
  ...over,
});

const txn = (id: string, over: Partial<TransactionRow> = {}): TransactionRow => ({
  id,
  accountId: 'a',
  ts: 1_000,
  status: 'booked',
  amountMinor: -150_50,
  currency: 'UAH',
  description: 'Сільпо',
  counterparty: null,
  comment: null,
  mcc: 5411,
  category: 'groceries',
  ...over,
});

describe('the phone’s store', () => {
  it('opens twice on the same database without losing anything', async () => {
    const db = memoryDb();
    const first = await Store.open(db);
    await first.replaceAccounts([account('a')]);
    const second = await Store.open(db);
    expect(await second.accounts()).toHaveLength(1);
  });

  it('keeps accounts as the bank last reported them and drops one that is gone, with its rows', async () => {
    const store = await openStore();
    await store.replaceAccounts([
      account('a'),
      account('b', { sort: 1, kind: 'jar', goalMinor: 5 }),
    ]);
    await store.upsertTransactions([txn('a:1'), txn('b:1', { accountId: 'b' })]);
    await store.replaceAccounts([account('a', { balanceMinor: 7 })]);
    expect(await store.accounts()).toEqual([account('a', { balanceMinor: 7 })]);
    expect((await store.transactions('', 10)).map((row) => row.id)).toEqual(['a:1']);
  });

  it('adds a row once and brings it up to date the second time', async () => {
    const store = await openStore();
    expect(await store.upsertTransactions([txn('a:1', { status: 'pending' }), txn('a:2')])).toBe(2);
    expect(await store.upsertTransactions([txn('a:1', { status: 'booked' })])).toBe(0);
    expect(await store.transactionCount()).toBe(2);
    const row = (await store.transactions('', 10)).find((r) => r.id === 'a:1');
    expect(row).toEqual(txn('a:1'));
  });

  it('searches Ukrainian text whatever the case, every word, in the description, counterparty or note', async () => {
    const store = await openStore();
    await store.upsertTransactions([
      txn('a:1', { ts: 3, description: 'Сільпо' }),
      txn('a:2', { ts: 2, description: 'Переказ', counterparty: 'Олена Їжак', comment: 'за каву' }),
      txn('a:3', { ts: 1, description: '100%_знижка' }),
    ]);
    const ids = async (query: string) => (await store.transactions(query, 10)).map((r) => r.id);
    expect(await ids('')).toEqual(['a:1', 'a:2', 'a:3']);
    expect(await ids('СІЛЬ')).toEqual(['a:1']);
    expect(await ids('їжак каву')).toEqual(['a:2']);
    expect(await ids('їжак чай')).toEqual([]);
    // What the person types is text, never a pattern.
    expect(await ids('%')).toEqual(['a:3']);
    expect(await ids('_')).toEqual(['a:3']);
    expect(await store.transactions('', 2)).toHaveLength(2);
  });

  it('hands out statement windows by priority, then in order', async () => {
    const store = await openStore();
    await store.addWindow('a', '2026-10-01', '2026-10-31', 2);
    await store.addWindow('a', '2026-11-01', '2026-11-11', 1);
    await store.addWindow('a', '2026-11-09', '2026-11-11', 0);
    const order: string[] = [];
    for (let next = await store.nextWindow(); next; next = await store.nextWindow()) {
      order.push(next.from);
      await store.finishWindow(next.id);
    }
    expect(order).toEqual(['2026-11-09', '2026-11-01', '2026-10-01']);
    expect(await store.windowCounts()).toEqual({ done: 3, total: 3 });
    await store.dropFinishedWindows();
    expect(await store.windowCounts()).toEqual({ done: 0, total: 0 });
  });

  it('removing the bank keeps the ФОП rows and the chosen rate', async () => {
    const store = await openStore();
    await store.replaceAccounts([account('a')]);
    await store.upsertTransactions([txn('a:1')]);
    await store.setMeta('connected', 'live');
    await store.setMeta('fopRate', '3');
    await store.upsertFopRows([
      {
        id: 'f1',
        ts: 1,
        day: '2026-01-10',
        account: '0001',
        currency: 'UAH',
        direction: 'in',
        amountMinor: 1_000_00,
        uahMinor: null,
        counterparty: 'ТОВ Вигадка',
        purpose: 'Оплата',
        kind: 'income',
      },
    ]);
    await store.setFopOverride('f1', false);
    await store.clearBank();
    expect(await store.accounts()).toEqual([]);
    expect(await store.transactionCount()).toBe(0);
    expect(await store.meta('connected')).toBeNull();
    expect(await store.meta('fopRate')).toBe('3');
    expect(await store.fopRows()).toEqual([expect.objectContaining({ id: 'f1', override: false })]);
    await store.clearFop();
    expect(await store.fopRows()).toEqual([]);
  });
});
