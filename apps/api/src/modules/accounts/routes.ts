import { AccountList, Id, RefreshAccountResponse } from '@ledger-lens/contracts';
import * as z from 'zod';
import { requireSession } from '../../plugins/session';
import type { App, AppContext } from '../../types';
import { toAccountDto } from '../connections/presenter';

export function registerAccountRoutes(api: App, ctx: AppContext): void {
  /** Cached data only: reading the dashboard never calls the bank. */
  api.get('/accounts', { schema: { response: { 200: AccountList } } }, (request) => ({
    items: ctx.repos.accounts.listBySession(requireSession(request).id).map(toAccountDto),
  }));

  /** The one place a bank is called on demand (the user is present, which PSD2 treats differently from background reads). */
  api.post(
    '/accounts/:id/refresh',
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: '1 minute',
          keyGenerator: (r) => r.cookies[ctx.sessions.cookieName] ?? r.ip,
        },
      },
      schema: { params: z.object({ id: Id }), response: { 200: RefreshAccountResponse } },
    },
    async (request) => {
      const result = await ctx.sync.refreshAccount(requireSession(request).id, request.params.id);
      return { account: toAccountDto(result.account), newTransactions: result.newTransactions };
    },
  );
}
