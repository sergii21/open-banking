import { z } from 'zod';

/**
 * Stable machine-readable error codes. The SPA maps each one to a designed state, so adding a
 * code here is a contract change: handle it in the web app's error mapping as well.
 */
export const ErrorCode = z.enum([
  'validation_failed',
  'session_required',
  'csrf_failed',
  'not_found',
  'conflict',
  'idempotency_conflict',
  'idempotency_key_required',
  'rate_limited',
  'refresh_cooldown',
  'consent_denied',
  'consent_expired',
  'consent_revoked',
  'reauth_required',
  'connection_not_active',
  'sca_timeout',
  'bank_unavailable',
  'provider_error',
  'provider_not_available',
  'payment_rejected',
  'insufficient_funds',
  'invalid_state',
  'invalid_webhook_signature',
  'payments_not_supported',
  'forbidden',
  'internal_error',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** RFC 9457 problem details with a stable `code` extension. */
export const Problem = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  code: ErrorCode,
  detail: z.string().optional(),
  instance: z.string().optional(),
  traceId: z.string().optional(),
  retryAfterSeconds: z.number().int().nonnegative().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
export type Problem = z.infer<typeof Problem>;

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
export const PROBLEM_TYPE_BASE = 'https://ledger-lens.dev/problems/';
