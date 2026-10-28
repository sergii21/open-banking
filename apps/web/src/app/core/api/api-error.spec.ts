import { HttpErrorResponse } from '@angular/common/http';
import { ErrorCode } from '@ledger-lens/contracts';
import { ApiError, describeError, toApiError } from './api-error';

const problem = (code: string, status: number, extra: object = {}) => ({
  type: 'https://ledger-lens.dev/problems/x',
  title: 'Title',
  status,
  code,
  ...extra,
});

describe('toApiError', () => {
  it('reads the stable code, status, detail and retry hint from problem+json', () => {
    const error = toApiError(
      new HttpErrorResponse({
        status: 429,
        error: problem('rate_limited', 429, { detail: 'Slow down', retryAfterSeconds: 30 }),
      }),
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      code: 'rate_limited',
      status: 429,
      message: 'Slow down',
      retryAfterSeconds: 30,
    });
  });

  it('treats status 0 as a network failure and unknown bodies as unknown', () => {
    expect(toApiError(new HttpErrorResponse({ status: 0 })).code).toBe('network');
    expect(toApiError(new HttpErrorResponse({ status: 500, error: '<html>' })).code).toBe(
      'unknown',
    );
    expect(toApiError(new Error('boom')).message).toBe('boom');
  });

  it('passes an ApiError through untouched', () => {
    const original = new ApiError('not_found', 404, 'nope');
    expect(toApiError(original)).toBe(original);
  });
});

describe('describeError', () => {
  it('has designed copy with a next step for every error code the API can return', () => {
    for (const code of ErrorCode.options) {
      const copy = describeError(
        new ApiError(code, 400, 'The server explained what went wrong here.'),
      );
      expect(copy.title.length, code).toBeGreaterThan(3);
      expect(copy.message.length, code).toBeGreaterThan(10);
      expect(copy.icon, code).toBeTruthy();
    }
  });

  it('offers the right recovery for the states that matter', () => {
    expect(describeError(new ApiError('reauth_required', 401, '')).action).toBe('reconnect');
    expect(describeError(new ApiError('consent_expired', 403, '')).action).toBe('reconnect');
    expect(describeError(new ApiError('bank_unavailable', 503, '')).action).toBe('retry');
    expect(describeError(new ApiError('session_required', 401, '')).action).toBe('reload');
    expect(describeError(new ApiError('network', 0, '')).action).toBe('retry');
  });

  it('puts the retry hint into the message', () => {
    const copy = describeError(new ApiError('rate_limited', 429, '', 30));
    expect(copy.message).toContain('30 seconds');
  });
});
