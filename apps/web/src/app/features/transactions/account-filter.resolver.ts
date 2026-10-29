import { inject, Injector } from '@angular/core';
import type { ResolveFn } from '@angular/router';

/** Applies `?account=` (from a dashboard account card) to the shared filters before the page renders. */
export const applyAccountFilter: ResolveFn<boolean> = async (route) => {
  const account = route.queryParamMap.get('account');
  if (account) {
    const injector = inject(Injector);
    // The store belongs to the transactions chunk: importing it here on demand keeps it (and the signal-store library)
    // out of the initial bundle, which routes would otherwise pull in just to name this resolver.
    const { TransactionFilters } = await import('./transaction-filters');
    injector.get(TransactionFilters).setAccount(account);
  }
  return true;
};
