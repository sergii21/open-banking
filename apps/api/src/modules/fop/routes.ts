import { FOP_RATES } from '@ledger-lens/contracts';
import * as z from 'zod';
import { requireSession } from '../../plugins/session';
import type { App, AppContext } from '../../types';

/** The ФОП report: what the statements add up to, which rows count, and removing the rows again. */
export function registerFopRoutes(api: App, ctx: AppContext): void {
  api.get(
    '/fop',
    {
      schema: {
        querystring: z.object({
          year: z
            .string()
            .regex(/^\d{4}$/)
            .optional(),
          rate: z.coerce
            .number()
            .refine((n) => (FOP_RATES as readonly number[]).includes(n))
            .optional(),
        }),
      },
    },
    (request) => {
      const rate = request.query.rate === 3 ? 3 : 5;
      return ctx.fop.report(requireSession(request), request.query.year, rate);
    },
  );

  api.patch(
    '/fop/rows/:id',
    {
      schema: {
        params: z.object({ id: z.string().min(1).max(64) }),
        body: z.object({ counted: z.boolean().nullable() }),
      },
    },
    (request) => {
      ctx.fop.setCounted(requireSession(request), request.params.id, request.body.counted);
      return { id: request.params.id, counted: request.body.counted };
    },
  );

  api.delete('/fop', (request, reply) => {
    ctx.fop.clear(requireSession(request));
    return reply.code(204).send();
  });
}
