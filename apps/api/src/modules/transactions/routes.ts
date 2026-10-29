import {
  Id,
  minorToDecimalString,
  Transaction,
  TransactionPage,
  TransactionQuery,
  UpdateTransactionRequest,
} from '@ledger-lens/contracts';
import * as z from 'zod';
import { number, text, toCsv } from '../../domain/csv';
import { AppError, notFound } from '../../errors';
import { requireSession } from '../../plugins/session';
import type { App, AppContext } from '../../types';
import { toTransactionDto } from '../connections/presenter';

/** A download is a convenience, not a bulk API: this is far more than a personal account produces in a year. */
const EXPORT_LIMIT = 50_000;

function assertSensibleQuery(query: TransactionQuery): void {
  const { from, to, minAmountMinor, maxAmountMinor } = query;
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
}

export function registerTransactionRoutes(api: App, ctx: AppContext): void {
  api.get(
    '/transactions',
    { schema: { querystring: TransactionQuery, response: { 200: TransactionPage } } },
    (request) => {
      assertSensibleQuery(request.query);
      const page = ctx.repos.transactions.list(requireSession(request).id, request.query);
      return {
        items: page.items.map(toTransactionDto),
        nextCursor: page.nextCursor,
        total: page.total,
      };
    },
  );

  /** Everything the filters match, as a spreadsheet. The paging parameters are ignored: a download is the whole answer. */
  api.get(
    '/transactions/export.csv',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: { querystring: TransactionQuery },
    },
    (request, reply) => {
      assertSensibleQuery(request.query);
      const session = requireSession(request);
      const accounts = new Map(
        ctx.repos.accounts.listBySession(session.id).map((account) => [account.id, account.name]),
      );
      const rows = ctx.repos.transactions.exportRows(session.id, request.query, EXPORT_LIMIT);
      const csv = toCsv(
        [
          'Date',
          'Status',
          'Account',
          'Description',
          'Counterparty',
          'Category',
          'Amount',
          'Currency',
        ],
        rows.map((row) => [
          text(row.bookedAt.slice(0, 10)),
          text(row.status),
          text(accounts.get(row.accountId)),
          text(row.description),
          text(row.counterparty),
          text(row.category),
          number(minorToDecimalString(row.amountMinor, row.currency)),
          text(row.currency),
        ]),
      );
      const day = ctx.clock.now().toISOString().slice(0, 10);
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="ledger-lens-transactions-${day}.csv"`)
        .header('cache-control', 'no-store')
        .send(csv);
    },
  );

  /** The customer's own category for one transaction. A category they chose is never overwritten by a later refresh. */
  api.patch(
    '/transactions/:id',
    {
      schema: {
        params: z.object({ id: Id }),
        body: UpdateTransactionRequest,
        response: { 200: Transaction },
      },
    },
    (request) => {
      const session = requireSession(request);
      const existing = ctx.repos.transactions.findForSession(session.id, request.params.id);
      if (!existing) throw notFound('Transaction');
      ctx.repos.transactions.updateCategory(existing.id, request.body.category);
      return toTransactionDto({
        ...existing,
        category: request.body.category,
        categorySource: 'user',
      });
    },
  );
}
