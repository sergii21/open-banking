import { HttpErrorResponse } from '@angular/common/http';
import { Problem, type ErrorCode } from '@ledger-lens/contracts';

export type ApiErrorCode = ErrorCode | 'network' | 'unknown';

/** A failed call to the BFF, carrying the stable `code` from the problem+json body. */
export class ApiError extends Error {
  override name = 'ApiError';

  constructor(
    readonly code: ApiErrorCode,
    readonly status: number,
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof HttpErrorResponse) {
    if (error.status === 0) return new ApiError('network', 0, 'Ledger Lens could not be reached.');
    const problem = Problem.safeParse(error.error);
    if (problem.success) {
      return new ApiError(
        problem.data.code,
        problem.data.status,
        problem.data.detail ?? problem.data.title,
        problem.data.retryAfterSeconds ?? null,
      );
    }
    return new ApiError('unknown', error.status, error.message);
  }
  return new ApiError(
    'unknown',
    0,
    error instanceof Error ? error.message : 'Something went wrong.',
  );
}

export type ErrorAction = 'retry' | 'reconnect' | 'reload' | 'none';

export interface ErrorCopy {
  title: string;
  message: string;
  icon: string;
  action: ErrorAction;
}

/** The designed copy for each stable error code. Every code the API can return maps to a state a person can act on. */
export function describeError(error: unknown): ErrorCopy {
  const e = toApiError(error);
  const wait = e.retryAfterSeconds ? ` Try again in ${e.retryAfterSeconds} seconds.` : '';
  switch (e.code) {
    case 'bank_unavailable':
      return {
        title: 'Your bank isn’t responding',
        message: `The bank didn’t answer, so we kept the data we already had. Nothing was changed.${wait}`,
        icon: 'cloud_off',
        action: 'retry',
      };
    case 'rate_limited':
      return {
        title: 'The bank is limiting requests',
        message: `Banks cap how often apps may read accounts on your behalf.${wait || ' Try again shortly.'}`,
        icon: 'speed',
        action: 'retry',
      };
    case 'refresh_cooldown':
      return {
        title: 'Refreshed moments ago',
        message: `This account was just updated.${wait}`,
        icon: 'schedule',
        action: 'none',
      };
    case 'reauth_required':
      return {
        title: 'Your bank needs you to sign in again',
        message:
          'The bank no longer accepts our access. This happens when consent is withdrawn or security checks expire. Reconnect to continue.',
        icon: 'lock_reset',
        action: 'reconnect',
      };
    case 'consent_expired':
      return {
        title: 'Access to this bank has ended',
        message:
          'Bank consent only lasts a limited time. Reconnect to keep your accounts up to date.',
        icon: 'event_busy',
        action: 'reconnect',
      };
    case 'consent_revoked':
      return {
        title: 'Access was revoked at the bank',
        message:
          'You (or the bank) withdrew consent. Reconnect if you want Ledger Lens to read this bank again.',
        icon: 'link_off',
        action: 'reconnect',
      };
    case 'connection_not_active':
      return {
        title: 'This connection isn’t active',
        message: e.message,
        icon: 'link_off',
        action: 'reconnect',
      };
    case 'insufficient_funds':
      return {
        title: 'Not enough money in the account',
        message: 'The bank declined the payment because the balance is too low.',
        icon: 'account_balance_wallet',
        action: 'none',
      };
    case 'payment_rejected':
      return {
        title: 'The bank rejected the payment',
        message: e.message,
        icon: 'block',
        action: 'none',
      };
    case 'validation_failed':
      return {
        title: 'That didn’t look right',
        message: e.message,
        icon: 'edit_off',
        action: 'none',
      };
    case 'session_required':
    case 'csrf_failed':
      return {
        title: 'Your session needs a refresh',
        message: 'Reload the page to start a new demo session.',
        icon: 'refresh',
        action: 'reload',
      };
    case 'not_found':
      return {
        title: 'We couldn’t find that',
        message: e.message,
        icon: 'search_off',
        action: 'none',
      };
    case 'provider_not_available':
      return {
        title: 'That bank isn’t available',
        message: e.message,
        icon: 'block',
        action: 'none',
      };
    case 'network':
      return {
        title: 'Can’t reach Ledger Lens',
        message: 'Check that the API is running and your connection is working, then try again.',
        icon: 'wifi_off',
        action: 'retry',
      };
    default:
      return {
        title: 'Something went wrong',
        message:
          'An unexpected error occurred. Try again, and if it keeps happening reload the page.',
        icon: 'error',
        action: 'retry',
      };
  }
}
