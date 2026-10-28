import { TestBed } from '@angular/core/testing';
import { TransactionFilters } from './transaction-filters';

describe('TransactionFilters', () => {
  let store: InstanceType<typeof TransactionFilters>;

  beforeEach(() => {
    vi.useFakeTimers();
    store = TestBed.inject(TransactionFilters);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with no filters and the default page size', () => {
    expect(store.params()).toEqual({ limit: '50' });
    expect(store.activeCount()).toBe(0);
  });

  it('turns selections into query parameters and counts them', () => {
    store.setAccount('acc_1');
    store.setCategory('groceries');
    store.setFrom('2026-10-01');
    store.setTo('2026-10-31');
    store.setDirection('out');
    expect(store.params()).toEqual({
      limit: '50',
      accountId: 'acc_1',
      category: 'groceries',
      from: '2026-10-01',
      to: '2026-10-31',
      direction: 'out',
    });
    expect(store.activeCount()).toBe(5);
  });

  it('waits for a pause in typing before the search applies, but shows the draft at once', () => {
    store.setQuery('r');
    store.setQuery('re');
    store.setQuery('rewe');
    expect(store.qDraft()).toBe('rewe');
    expect(store.params()['q']).toBeUndefined();

    vi.advanceTimersByTime(249);
    expect(store.params()['q']).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(store.params()['q']).toBe('rewe');
  });

  it('converts typed amounts to minor units and ignores invalid or incomplete ones', () => {
    store.setMin('12.50');
    store.setMax('1 000');
    vi.advanceTimersByTime(250);
    expect(store.params()).toMatchObject({ minAmountMinor: '1250', maxAmountMinor: '100000' });

    store.setMin('abc');
    vi.advanceTimersByTime(250);
    expect(store.params()['minAmountMinor']).toBeUndefined();
    expect(store.activeCount()).toBe(1);
  });

  it('resets everything and cancels pending debounces', () => {
    store.setQuery('netflix');
    store.setAccount('acc_1');
    store.reset();
    vi.advanceTimersByTime(500);
    expect(store.params()).toEqual({ limit: '50' });
    expect(store.qDraft()).toBe('');
  });
});
