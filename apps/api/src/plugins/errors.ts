import {
  PROBLEM_CONTENT_TYPE,
  PROBLEM_TYPE_BASE,
  type ErrorCode,
  type Problem,
} from '@ledger-lens/contracts';
import type { FastifyError } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { AppError, internalProblem, toProblem } from '../errors';
import { stripQuery } from '../logging';
import type { App } from '../types';

function statusToCode(status: number): ErrorCode {
  switch (status) {
    case 400:
    case 413:
    case 415:
    case 422:
      return 'validation_failed';
    case 401:
      return 'session_required';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 429:
      return 'rate_limited';
    default:
      return 'internal_error';
  }
}

/** Every failure leaves the API as RFC 9457 `application/problem+json` with a stable `code`. */
export function registerErrorHandling(app: App): void {
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const instance = stripQuery(request.url);
    const traceId = request.id;
    let problem: Problem;

    if (error instanceof AppError) {
      problem = toProblem(error, instance, traceId);
    } else if (hasZodFastifySchemaValidationErrors(error)) {
      problem = {
        type: `${PROBLEM_TYPE_BASE}validation-failed`,
        title: 'The request is not valid',
        status: 400,
        code: 'validation_failed',
        instance,
        traceId,
        errors: error.validation.map((issue) => ({
          path: issue.instancePath.replace(/^\//, '').replaceAll('/', '.') || '(request)',
          message: issue.message ?? 'Invalid value',
        })),
      };
    } else if (isResponseSerializationError(error)) {
      request.log.error({ err: error }, 'response did not match its contract');
      problem = internalProblem(instance, traceId);
    } else {
      const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
      if (status >= 500) {
        request.log.error({ err: error }, 'unhandled error');
        problem = internalProblem(instance, traceId);
      } else {
        const code = statusToCode(status);
        problem = {
          type: `${PROBLEM_TYPE_BASE}${code.replaceAll('_', '-')}`,
          title: error.message || 'Bad request',
          status,
          code,
          instance,
          traceId,
        };
      }
    }

    if (problem.status < 500 && !(error instanceof AppError)) {
      request.log.info({ code: problem.code, status: problem.status }, 'request rejected');
    }
    void reply
      .code(problem.status)
      .type(PROBLEM_CONTENT_TYPE)
      .headers(
        problem.retryAfterSeconds === undefined
          ? {}
          : { 'retry-after': String(problem.retryAfterSeconds) },
      )
      .send(problem);
  });
}
