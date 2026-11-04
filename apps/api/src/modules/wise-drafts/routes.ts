import * as z from 'zod';
import { requireSession } from '../../plugins/session';
import type { App, AppContext } from '../../types';

const AccountId = z.string().min(1).max(64);
const RecipientId = z.number().int().positive();
const Uuid = z.string().regex(/^[0-9a-fA-F-]{8,64}$/);

/** Draft Wise transfers. These create an unpaid transfer at most: the person pays it in Wise, and no route here can. */
export function registerWiseDraftRoutes(api: App, ctx: AppContext): void {
  const limited = { rateLimit: { max: 30, timeWindow: '1 minute' } };

  api.get(
    '/wise/drafts',
    { schema: { querystring: z.object({ accountId: AccountId.optional() }) } },
    (request) => ctx.wiseDrafts.overview(requireSession(request).id, request.query.accountId),
  );

  api.post(
    '/wise/drafts/quote',
    {
      config: limited,
      schema: {
        body: z.object({
          accountId: AccountId,
          recipientId: RecipientId,
          targetCurrency: z.string().regex(/^[A-Z]{3}$/),
          amountMinor: z.number().int().positive().max(1_000_000_000_000),
        }),
      },
    },
    (request) => ctx.wiseDrafts.quote(requireSession(request).id, request.body),
  );

  api.post(
    '/wise/drafts',
    {
      config: limited,
      schema: {
        body: z.object({
          accountId: AccountId,
          recipientId: RecipientId,
          quoteId: Uuid,
          draftKey: Uuid,
          reference: z.string().max(140).optional(),
        }),
      },
    },
    async (request, reply) => {
      const created = await ctx.wiseDrafts.create(requireSession(request).id, request.body);
      return reply.code(201).send(created);
    },
  );
}
