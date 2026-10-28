import { InspectorCallList } from '@ledger-lens/contracts';
import * as z from 'zod';
import { requireSession } from '../../plugins/session';
import type { App, AppContext } from '../../types';

export function registerInspectorRoutes(api: App, ctx: AppContext): void {
  /** The last 200 provider calls made for this session, redacted, newest first. */
  api.get('/inspector/calls', { schema: { response: { 200: InspectorCallList } } }, (request) => ({
    items: ctx.inspector.list(requireSession(request).id),
  }));

  api.delete(
    '/inspector/calls',
    { schema: { response: { 204: z.null() } } },
    async (request, reply) => {
      ctx.inspector.clear(requireSession(request).id);
      return reply.code(204).send(null);
    },
  );
}
