import { HttpContextToken, type HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { toApiError } from '../api/api-error';
import { SessionService } from '../session/session';

const RETRIED = new HttpContextToken<boolean>(() => false);

/**
 * Turns every failed call into an `ApiError` (stable `code` from problem+json), and quietly starts a new demo
 * session once if the cookie is gone (server restart, session TTL) before giving up.
 */
export const problemInterceptor: HttpInterceptorFn = (request, next) => {
  const session = inject(SessionService);
  return next(request).pipe(
    catchError((error: unknown) => {
      const apiError = toApiError(error);
      const canRetry =
        apiError.code === 'session_required' &&
        !request.context.get(RETRIED) &&
        !request.url.startsWith('/api/session');
      if (!canRetry) return throwError(() => apiError);

      return from(session.bootstrap()).pipe(
        switchMap(() => next(request.clone({ context: request.context.set(RETRIED, true) }))),
        catchError((retryError: unknown) => throwError(() => toApiError(retryError))),
      );
    }),
  );
};
