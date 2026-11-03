import { CATEGORIES, type ActivityRow, type Activity } from '@ledger-lens/contracts';
import * as z from 'zod';
import { notFound } from '../errors';
import { requireSession } from '../plugins/session';
import type { App, AppContext } from '../types';
import { primaryConnection } from './connection/presenter';
import { toAccountDto } from './home/presenter';

const CategoryEnum = z.enum(CATEGORIES);
const THIRTEEN_MONTHS_MS = 400 * 86_400_000;

/** Home, Activity, Insights, sync, diagnostics: everything the three tabs and the settings sheet read or ask for. */
export function registerAppRoutes(api: App, ctx: AppContext): void {
  api.get('/home', async (request) => ctx.home.build(requireSession(request)));

  api.get('/activity', async (request): Promise<Activity> => {
    const session = requireSession(request);
    const connections = ctx.connections.requireAny(session.id);
    const accounts = ctx.repos.accounts.listBySession(session.id);
    const primary = primaryConnection(connections);
    if (!primary) throw notFound('Connection');
    const { table } = await ctx.rates.get(primary);
    const states = ctx.sync.accountStates(session.id);
    const byId = new Map(connections.map((c) => [c.id, c]));
    const since = ctx.clock.now().getTime() - THIRTEEN_MONTHS_MS;
    const rows: ActivityRow[] = ctx.repos.transactions
      .listForSession(session.id, since)
      .map((r) => ({
        id: r.id,
        accountId: r.accountId,
        ts: r.ts,
        status: r.status,
        amountMinor: r.amountMinor,
        currency: r.currency,
        description: r.description,
        category: r.category,
        ...(r.categorySource === 'user' ? { chosen: true as const } : {}),
        ...(r.counterparty ? { counterparty: r.counterparty } : {}),
        ...(r.mcc ? { mcc: r.mcc } : {}),
        ...(r.cashbackMinor ? { cashbackMinor: r.cashbackMinor } : {}),
        ...(r.commissionMinor ? { commissionMinor: r.commissionMinor } : {}),
        ...(r.comment ? { comment: r.comment } : {}),
        ...(r.receiptId ? { receiptId: r.receiptId } : {}),
        ...(r.balanceAfterMinor !== null ? { balanceAfterMinor: r.balanceAfterMinor } : {}),
      }));
    return {
      rows,
      accounts: accounts.map((a) =>
        toAccountDto(a, states.get(a.id), table, byId.get(a.connectionId)),
      ),
      demo: connections.some((c) => c.provider === 'demo'),
      version: ctx.sync.stateForSession(session.id).version,
    };
  });

  api.patch(
    '/transactions/:id',
    {
      schema: {
        params: z.object({ id: z.string().min(1).max(64) }),
        body: z.object({ category: CategoryEnum }),
      },
    },
    (request) => {
      const session = requireSession(request);
      const found = ctx.repos.transactions.findForSession(session.id, request.params.id);
      if (!found) throw notFound('Transaction');
      ctx.repos.transactions.updateCategory(found.id, request.body.category);
      return { id: found.id, category: request.body.category, categorySource: 'user' as const };
    },
  );

  api.get(
    '/insights',
    {
      schema: {
        querystring: z.object({
          month: z
            .string()
            .regex(/^\d{4}-\d{2}$/)
            .optional(),
        }),
      },
    },
    async (request) => ctx.insights.build(requireSession(request), request.query.month),
  );

  api.get('/sync', (request) => {
    const session = requireSession(request);
    ctx.connections.requireAny(session.id);
    return ctx.sync.stateForSession(session.id);
  });
  api.post('/sync/refresh', async (request) => ctx.sync.refresh(requireSession(request).id));
  api.post(
    '/sync/load-earlier',
    {
      schema: { body: z.object({ connectionId: z.string().min(1).max(64).optional() }).optional() },
    },
    (request) => ctx.sync.loadEarlier(requireSession(request).id, request.body?.connectionId),
  );
  api.post(
    '/accounts/:id/prioritise',
    { schema: { params: z.object({ id: z.string().min(1).max(64) }) } },
    (request) => ctx.sync.prioritise(requireSession(request).id, request.params.id),
  );

  api.get('/diagnostics', async (request) => ({
    text: await ctx.diagnostics.build(requireSession(request)),
  }));
}
