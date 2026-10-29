import { InsightsQuery, InsightsSummary } from '@ledger-lens/contracts';
import type { TransactionRecord } from '../../db/repos';
import {
  defaultWindow,
  detectRecurring,
  summarise,
  type InsightTransaction,
} from '../../domain/insights';
import { AppError } from '../../errors';
import { requireSession } from '../../plugins/session';
import type { App, AppContext } from '../../types';

/** Standing payments are found in the last 13 months, whatever window the screen shows: they are a property of the history. */
const RECURRING_LOOKBACK_MONTHS = 13;
const MAX_WINDOW_MONTHS = 36;

const toInsight = (row: TransactionRecord): InsightTransaction => ({
  id: row.id,
  accountId: row.accountId,
  bookedAt: row.bookedAt,
  amountMinor: row.amountMinor,
  currency: row.currency,
  description: row.description,
  counterparty: row.counterparty,
  category: row.category,
});

const monthIndex = (isoDate: string): number =>
  Number(isoDate.slice(0, 4)) * 12 + Number(isoDate.slice(5, 7));

export function registerInsightRoutes(api: App, ctx: AppContext): void {
  api.get(
    '/insights/summary',
    { schema: { querystring: InsightsQuery, response: { 200: InsightsSummary } } },
    (request) => {
      const session = requireSession(request);
      const today = ctx.clock.now();
      const fallback = defaultWindow(today);
      const from = request.query.from ?? fallback.from;
      const to =
        request.query.to ?? (request.query.from ? today.toISOString().slice(0, 10) : fallback.to);

      if (from > to)
        throw new AppError('validation_failed', 400, 'The start date is after the end date.');
      if (monthIndex(to) - monthIndex(from) >= MAX_WINDOW_MONTHS) {
        throw new AppError(
          'validation_failed',
          400,
          `Choose a period of at most ${MAX_WINDOW_MONTHS} months.`,
        );
      }

      const inWindow = ctx.repos.transactions
        .listForInsights(session.id, `${from}T00:00:00.000Z`, `${to}T23:59:59.999Z`)
        .map(toInsight);
      const lookbackStart = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - RECURRING_LOOKBACK_MONTHS, 1),
      );
      const history = ctx.repos.transactions
        .listForInsights(session.id, lookbackStart.toISOString(), today.toISOString())
        .map(toInsight);

      return {
        from,
        to,
        currencies: summarise(inWindow, { from, to }),
        recurring: detectRecurring(history, today),
      };
    },
  );
}
