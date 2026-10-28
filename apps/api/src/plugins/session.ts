import type { FastifyRequest } from 'fastify';
import type { SessionRecord } from '../db/repos';
import { safeEqual } from '../domain/crypto';
import { AppError } from '../errors';
import { CSRF_HEADER } from '../modules/session/service';
import type { App, AppContext } from '../types';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the session hook for every `/api` route; null when no valid session cookie was sent. */
    session: SessionRecord | null;
  }
  interface FastifyContextConfig {
    /** Reachable without a session (session bootstrap, provider redirects, webhooks). */
    public?: boolean;
    /** Skip the CSRF check (only for callers that cannot hold a cookie, such as provider webhooks). */
    csrf?: boolean;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** For handlers behind the session hook, where a missing session has already been rejected. */
export function requireSession(request: FastifyRequest): SessionRecord {
  if (!request.session) throw new AppError('session_required', 401, 'Start a session first.');
  return request.session;
}

/**
 * Session lookup and CSRF protection for everything under `/api`.
 *
 * CSRF = SameSite=Lax cookie + Angular's double-submit header: the XSRF-TOKEN cookie is readable by the SPA, which echoes
 * it as X-XSRF-TOKEN. The token is an HMAC of the session id, so it is bound to the session, and a browser-supplied Origin
 * must match the public URL.
 */
export function registerSessionHooks(api: App, ctx: AppContext): void {
  const publicOrigin = new URL(ctx.config.publicUrl).origin;
  api.decorateRequest('session', null);

  api.addHook('onRequest', (request, _reply, done) => {
    const config = request.routeOptions.config;
    request.session = ctx.sessions.resolve(request.cookies[ctx.sessions.cookieName]);
    if (config.public) return done();

    const session = request.session;
    if (!session) {
      return done(
        new AppError(
          'session_required',
          401,
          'Your session has ended. Reload the page to start again.',
        ),
      );
    }

    if (!SAFE_METHODS.has(request.method) && config.csrf !== false) {
      const header = request.headers[CSRF_HEADER];
      const origin = request.headers.origin;
      const valid =
        typeof header === 'string' &&
        safeEqual(header, ctx.sessions.csrfToken(session.id)) &&
        (origin === undefined || origin === publicOrigin);
      if (!valid) {
        return done(
          new AppError(
            'csrf_failed',
            403,
            'The request could not be verified. Reload the page and try again.',
          ),
        );
      }
    }
    return done();
  });
}
