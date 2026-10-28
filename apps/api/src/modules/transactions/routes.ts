import { TransactionPage, TransactionQuery } from '@ledger-lens/contracts';
import { AppError } from '../../errors';
import { requireSession } from '../../plugins/session';
import type { App, AppContext } from '../../types';
import { toTransactionDto } from '../connections/presenter';

export function registerTransactionRoutes(api: App, ctx: AppContext): void {
  api.get(
    '/transactions',
    { schema: { querystring: TransactionQuery, response: { 200: TransactionPage } } },
    (request) => {
      const { from, to, minAmountMinor, maxAmountMinor } = request.query;
      if (from && to && from > to) {
        throw new AppError('validation_failed', 400, 'The start date is after the end date.');
      }
      if (
        minAmountMinor !== undefined &&
        maxAmountMinor !== undefined &&
        minAmountMinor > maxAmountMinor
      ) {
        throw new AppError('validation_failed', 400, 'The minimum amount is above the maximum.');
      }
      const page = ctx.repos.transactions.list(requireSession(request).id, request.query);
      return {
        items: page.items.map(toTransactionDto),
        nextCursor: page.nextCursor,
        total: page.total,
      };
    },
  );
}
