import { requireSession } from '../../plugins/session';
import type { App, AppContext } from '../../types';

export function registerInspectorRoutes(api: App, ctx: AppContext): void {
  /** The last 200 calls made to the bank for this session, redacted, newest first: the Live API drawer. */
  api.get('/inspector/calls', (request) => ({
    items: ctx.inspector.list(requireSession(request).id),
  }));

  api.delete('/inspector/calls', async (request, reply) => {
    ctx.inspector.clear(requireSession(request).id);
    return reply.code(204).send();
  });
}
