import { PROBLEM_TYPE_BASE, type ErrorCode, type Problem } from '@ledger-lens/contracts';

const TITLES: Record<ErrorCode, string> = {
  validation_failed: 'The request is not valid',
  session_required: 'A session is required',
  csrf_failed: 'The request could not be verified',
  not_found: 'Not found',
  conflict: 'Conflict',
  rate_limited: 'Too many requests',
  refresh_cooldown: 'Refreshed too recently',
  reauth_required: 'monobank needs a new token',
  connection_not_active: 'This connection is not active',
  bank_unavailable: 'The bank is unavailable',
  provider_error: 'The bank returned something unexpected',
  provider_not_available: 'This is not available here',
  forbidden: 'Forbidden',
  internal_error: 'Something went wrong',
};

export interface AppErrorOptions {
  retryAfterSeconds?: number;
  errors?: { path: string; message: string }[];
  cause?: unknown;
}

/** A failure the API wants to report to the client with a stable `code`. */
export class AppError extends Error {
  override name = 'AppError';
  readonly retryAfterSeconds: number | undefined;
  readonly errors: { path: string; message: string }[] | undefined;

  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    detail?: string,
    options: AppErrorOptions = {},
  ) {
    super(
      detail ?? TITLES[code],
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.errors = options.errors;
  }
}

export const notFound = (what: string): AppError =>
  new AppError('not_found', 404, `${what} was not found.`);

export function toProblem(error: AppError, instance: string, traceId: string): Problem {
  return {
    type: `${PROBLEM_TYPE_BASE}${error.code.replaceAll('_', '-')}`,
    title: TITLES[error.code],
    status: error.status,
    code: error.code,
    detail: error.message === TITLES[error.code] ? undefined : error.message,
    instance,
    traceId,
    retryAfterSeconds: error.retryAfterSeconds,
    errors: error.errors,
  };
}

export function internalProblem(instance: string, traceId: string): Problem {
  return {
    type: `${PROBLEM_TYPE_BASE}internal-error`,
    title: TITLES.internal_error,
    status: 500,
    code: 'internal_error',
    instance,
    traceId,
  };
}
