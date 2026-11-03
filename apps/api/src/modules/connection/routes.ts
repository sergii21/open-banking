import * as z from 'zod';
import { requireSession } from '../../plugins/session';
import type { App, AppContext } from '../../types';
import { toConnectionInfo } from './presenter';

const Token = z.string().min(1).max(1024);
const ConnectBody = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('demo') }),
  z.object({ mode: z.literal('token'), token: Token }),
]);

export function registerConnectionRoutes(api: App, ctx: AppContext): void {
  // Connecting reads the bank once; its own limit is one a minute, ours just keeps a loop from hammering the check.
  const limited = { rateLimit: { max: 20, timeWindow: '1 minute' } };

  /** Start with a token the person pasted, or with the demo bank. Connecting again with the same bank keeps what is stored. */
  api.post(
    '/connection',
    { config: limited, schema: { body: ConnectBody } },
    async (request, reply) => {
      const record = await ctx.connections.connect(requireSession(request), request.body);
      return reply.code(201).send(toConnectionInfo(record));
    },
  );

  /** Replace a token monobank stopped accepting; history stays. */
  api.put(
    '/connection/token',
    { config: limited, schema: { body: z.object({ token: Token }) } },
    async (request) => {
      const record = await ctx.connections.connect(requireSession(request), {
        mode: 'token',
        token: request.body.token,
      });
      return toConnectionInfo(record);
    },
  );

  /** Forget the bank here: the token and everything read with it are deleted. */
  api.delete('/connection', async (request, reply) => {
    await ctx.connections.disconnect(requireSession(request).id);
    return reply.code(204).send();
  });
}
