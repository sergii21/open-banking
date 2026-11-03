/**
 * Stable machine-readable error codes. The SPA maps each one to a designed state, so adding a code here is a contract
 * change: handle it in the web app's error mapping as well.
 */
export const ERROR_CODES = [
  'validation_failed',
  'session_required',
  'csrf_failed',
  'not_found',
  'conflict',
  'rate_limited',
  'refresh_cooldown',
  'reauth_required',
  'connection_not_active',
  'bank_unavailable',
  'provider_error',
  'provider_not_available',
  'unsupported_file',
  'forbidden',
  'internal_error',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** RFC 9457 problem details with a stable `code` extension. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail?: string;
  instance?: string;
  traceId?: string;
  /** Set when waiting helps: a bank that caps read speed says how long in a 429. */
  retryAfterSeconds?: number;
  errors?: { path: string; message: string }[];
}
