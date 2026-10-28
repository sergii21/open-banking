import { inject } from '@angular/core';
import type { ResolveFn } from '@angular/router';
import { TransactionFilters } from './transaction-filters';

/** Applies `?account=` (from a dashboard account card) to the shared filters before the page renders. */
export const applyAccountFilter: ResolveFn<boolean> = (route) => {
  const account = route.queryParamMap.get('account');
  if (account) inject(TransactionFilters).setAccount(account);
  return true;
};
