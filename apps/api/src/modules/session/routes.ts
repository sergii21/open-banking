import { SessionInfo } from '@ledger-lens/contracts';
import * as z from 'zod';
import { requireSession } from '../../plugins/session';
import type { App, AppContext } from '../../types';
import { CSRF_COOKIE } from './service';

export function registerSessionRoutes(api: App, ctx: AppContext): void {
  const cookieBase = {
    path: '/',
    sameSite: 'lax' as const,
    secure: ctx.config.secureCookies,
    maxAge: ctx.sessions.cookieMaxAgeSeconds,
  };

  /** Bootstraps the anonymous session (cookie + XSRF cookie) or resumes the one the browser already has. */
  api.get(
    '/session',
    { config: { public: true }, schema: { response: { 200: SessionInfo } } },
    (request, reply) => {
      let record = request.session;
      if (!record) {
        const created = ctx.sessions.create();
        record = created.record;
        reply.setCookie(ctx.sessions.cookieName, created.token, { ...cookieBase, httpOnly: true });
      }
      // Readable by the SPA on purpose: Angular copies it into the X-XSRF-TOKEN header on mutating calls.
      reply.setCookie(CSRF_COOKIE, ctx.sessions.csrfToken(record.id), {
        ...cookieBase,
        httpOnly: false,
      });
      reply.header('cache-control', 'no-store');
      return ctx.sessions.toInfo(record);
    },
  );

  /** "Delete all my data": withdraw consents, erase everything, end the session. */
  api.delete('/session', { schema: { response: { 204: z.null() } } }, async (request, reply) => {
    const session = requireSession(request);
    await ctx.sessions.deleteAll(session);
    reply.clearCookie(ctx.sessions.cookieName, { path: '/' });
    reply.clearCookie(CSRF_COOKIE, { path: '/' });
    return reply.code(204).send(null);
  });
}
