import * as z from 'zod';
import { requireSession } from '../../plugins/session';
import type { App, AppContext } from '../../types';
import { toConnectionInfo } from './presenter';

const Token = z.string().min(1).max(1024);
const ConnectBody = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('demo') }),
  z.object({
    mode: z.literal('token'),
    provider: z.enum(['monobank', 'privatbank', 'wise']).default('monobank'),
    token: Token,
  }),
]);
const IdParams = z.object({ id: z.string().min(1).max(64) });

export function registerConnectionRoutes(api: App, ctx: AppContext): void {
  // Connecting reads the bank once; its own limit is one a minute, ours just keeps a loop from hammering the check.
  const limited = { rateLimit: { max: 20, timeWindow: '1 minute' } };

  /** Start with a token the person pasted, or with the demo bank. Connecting the same bank again keeps what is stored. */
  api.post(
    '/connection',
    { config: limited, schema: { body: ConnectBody } },
    async (request, reply) => {
      const record = await ctx.connections.connect(requireSession(request), request.body);
      return reply.code(201).send(toConnectionInfo(record));
    },
  );

  /** Replace a token the bank stopped accepting; history stays. */
  api.put(
    '/connection/:id/token',
    { config: limited, schema: { params: IdParams, body: z.object({ token: Token }) } },
    async (request) => {
      const record = await ctx.connections.replaceToken(
        requireSession(request),
        request.params.id,
        request.body.token,
      );
      return toConnectionInfo(record);
    },
  );

  /** Forget one bank here: its token and everything read with it are deleted. */
  api.delete('/connection/:id', { schema: { params: IdParams } }, async (request, reply) => {
    await ctx.connections.disconnect(requireSession(request).id, request.params.id);
    return reply.code(204).send();
  });
}
