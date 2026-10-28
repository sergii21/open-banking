import { computed } from '@angular/core';
import { patchState, signalStore, withComputed, withMethods, withState } from '@ngrx/signals';
import { toMinorUnits, type Category } from '@ledger-lens/contracts';

type Direction = 'all' | 'in' | 'out';

interface FiltersState {
  accountId: string | null;
  category: Category | null;
  /** Applied to the query. */
  q: string;
  /** What the search box shows while the 250 ms debounce is pending. */
  qDraft: string;
  from: string;
  to: string;
  direction: Direction;
  /** Applied amount bounds, as typed (decimal major units). */
  minAmount: string;
  maxAmount: string;
  minDraft: string;
  maxDraft: string;
}

const initialState: FiltersState = {
  accountId: null,
  category: null,
  q: '',
  qDraft: '',
  from: '',
  to: '',
  direction: 'all',
  minAmount: '',
  maxAmount: '',
  minDraft: '',
  maxDraft: '',
};

const DEBOUNCE_MS = 250;

/**
 * Filters shared between screens: the dashboard's "Transactions" link on an account card sets the account, and the list
 * keeps your filters when you navigate away and back. Typed fields (search, amounts) apply after a short pause.
 */
export const TransactionFilters = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withComputed((state) => ({
    /** Query-string parameters for `GET /api/transactions` (without paging). */
    params: computed(() => {
      const params: Record<string, string> = { limit: '50' };
      if (state.accountId()) params['accountId'] = state.accountId() as string;
      if (state.category()) params['category'] = state.category() as string;
      if (state.q().trim()) params['q'] = state.q().trim();
      if (state.from()) params['from'] = state.from();
      if (state.to()) params['to'] = state.to();
      if (state.direction() !== 'all') params['direction'] = state.direction();
      // Amounts are typed in major units; the API filters on absolute minor units (2 decimals covers EUR and GBP).
      const min = toMinorUnits(state.minAmount(), 'EUR');
      const max = toMinorUnits(state.maxAmount(), 'EUR');
      if (min !== null) params['minAmountMinor'] = String(min);
      if (max !== null) params['maxAmountMinor'] = String(max);
      return params;
    }),
    activeCount: computed(
      () =>
        [
          state.accountId() !== null,
          state.category() !== null,
          state.q().trim() !== '',
          state.from() !== '',
          state.to() !== '',
          state.direction() !== 'all',
          toMinorUnits(state.minAmount(), 'EUR') !== null,
          toMinorUnits(state.maxAmount(), 'EUR') !== null,
        ].filter(Boolean).length,
    ),
  })),
  withMethods((store) => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const debounced = (key: 'q' | 'min' | 'max', value: string): void => {
      clearTimeout(timers.get(key));
      timers.set(
        key,
        setTimeout(() => {
          if (key === 'q') patchState(store, { q: value });
          else if (key === 'min') patchState(store, { minAmount: value });
          else patchState(store, { maxAmount: value });
        }, DEBOUNCE_MS),
      );
    };
    return {
      setAccount: (accountId: string | null) => patchState(store, { accountId }),
      setCategory: (category: Category | null) => patchState(store, { category }),
      setFrom: (from: string) => patchState(store, { from }),
      setTo: (to: string) => patchState(store, { to }),
      setDirection: (direction: Direction) => patchState(store, { direction }),
      setQuery(value: string) {
        patchState(store, { qDraft: value });
        debounced('q', value);
      },
      setMin(value: string) {
        patchState(store, { minDraft: value });
        debounced('min', value);
      },
      setMax(value: string) {
        patchState(store, { maxDraft: value });
        debounced('max', value);
      },
      reset() {
        for (const timer of timers.values()) clearTimeout(timer);
        patchState(store, initialState);
      },
    };
  }),
);
