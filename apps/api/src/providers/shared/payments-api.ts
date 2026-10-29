import type { PaymentFailureReason, PaymentStatus } from '@ledger-lens/contracts';
import * as z from 'zod';
import type { Clock } from '../../clock';
import type { PaymentUpdate } from '../../domain/payment-state';
import { AppError } from '../../errors';
import type { CallContext } from '../port';
import type { HttpResult } from '../transport';
import { normaliseTimestamp } from './data-api';

/**
 * DTOs and mappers for the "Payments v3" dialect: statuses `authorization_required` .. `settled` / `failed`, a failure
 * stage and reason, `*_at` timestamps, and TrueLayer-shaped webhook events. TrueLayer speaks it and the mock bank
 * deliberately mimics it, so this layer is exercised offline either way. What differs (credentials, request signing,
 * webhook verification) lives in each adapter.
 */

export const CreatePaymentResponseDto = z.object({
  id: z.string().min(1),
  resource_token: z.string().min(1),
  status: z.string().nullish(),
  hosted_page: z.object({ uri: z.string().min(1) }).nullish(),
});

const Timestamp = z.string().nullish();

export const PaymentDto = z.object({
  id: z.string().min(1),
  status: z.string(),
  created_at: Timestamp,
  authorized_at: Timestamp,
  executed_at: Timestamp,
  settled_at: Timestamp,
  failed_at: Timestamp,
  failure_stage: z.string().nullish(),
  failure_reason: z.string().nullish(),
});
export type PaymentDto = z.infer<typeof PaymentDto>;

export const WebhookEventDto = z.object({
  type: z.string().min(1),
  event_id: z.string().min(1),
  payment_id: z.string().min(1).nullish(),
  authorized_at: Timestamp,
  executed_at: Timestamp,
  settled_at: Timestamp,
  failed_at: Timestamp,
  failure_stage: z.string().nullish(),
  failure_reason: z.string().nullish(),
});
export type WebhookEventDto = z.infer<typeof WebhookEventDto>;

export const PaymentsTokenDto = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
});

const FAILURE_BY_REASON: Record<string, PaymentFailureReason> = {
  authorization_failed: 'authorisation_failed',
  not_authorized: 'authorisation_failed',
  invalid_credentials: 'authorisation_failed',
  invalid_otp: 'authorisation_failed',
  provider_expired: 'authorisation_failed',
  expired: 'expired',
  insufficient_funds: 'insufficient_funds',
  provider_error: 'provider_error',
  internal_server_error: 'provider_error',
  unknown_error: 'provider_error',
};

const CANCELLED_REASONS = new Set(['canceled', 'cancelled', 'user_canceled_at_provider']);

/** What a failed payment means for the customer, from the provider's reason (or, failing that, the stage it failed at). */
export function mapFailure(
  reason: string | null | undefined,
  stage: string | null | undefined,
): { status: Extract<PaymentStatus, 'failed' | 'cancelled'>; failureReason: PaymentFailureReason } {
  if (reason && CANCELLED_REASONS.has(reason)) {
    return { status: 'cancelled', failureReason: 'cancelled' };
  }
  const known = reason ? FAILURE_BY_REASON[reason] : undefined;
  if (known) return { status: 'failed', failureReason: known };
  if (reason) return { status: 'failed', failureReason: 'execution_rejected' };
  switch (stage) {
    case 'authorization_required':
    case 'authorizing':
      return { status: 'failed', failureReason: 'authorisation_failed' };
    case 'authorized':
      return { status: 'failed', failureReason: 'execution_rejected' };
    default:
      return { status: 'failed', failureReason: 'provider_error' };
  }
}

const stamp = (value: string | null | undefined, fallback: string): string =>
  value ? normaliseTimestamp(value) : fallback;

/** The state a provider's payment object describes. An unknown status is drift, reported rather than guessed at. */
export function mapPayment(dto: PaymentDto, fallbackAt: string): PaymentUpdate {
  switch (dto.status) {
    case 'authorization_required':
    case 'authorizing':
      return {
        status: 'pending',
        failureReason: null,
        at: stamp(dto.created_at, fallbackAt),
        note: null,
      };
    case 'authorized':
      return {
        status: 'authorised',
        failureReason: null,
        at: stamp(dto.authorized_at, fallbackAt),
        note: null,
      };
    case 'executed':
      return {
        status: 'executed',
        failureReason: null,
        at: stamp(dto.executed_at, fallbackAt),
        note: null,
      };
    case 'settled':
      return {
        status: 'settled',
        failureReason: null,
        at: stamp(dto.settled_at, fallbackAt),
        note: null,
      };
    case 'failed': {
      const failure = mapFailure(dto.failure_reason, dto.failure_stage);
      return {
        ...failure,
        at: stamp(dto.failed_at, fallbackAt),
        note: dto.failure_reason ? `Bank reason: ${dto.failure_reason}` : null,
      };
    }
    default:
      throw new AppError('provider_error', 502, 'The bank returned an unknown payment status.');
  }
}

/** A webhook event as a payment update, or null for events that are not about a payment's progress. */
export function mapWebhookEvent(dto: WebhookEventDto, fallbackAt: string): PaymentUpdate | null {
  switch (dto.type) {
    case 'payment_authorized':
      return {
        status: 'authorised',
        failureReason: null,
        at: stamp(dto.authorized_at, fallbackAt),
        note: null,
      };
    case 'payment_executed':
      return {
        status: 'executed',
        failureReason: null,
        at: stamp(dto.executed_at, fallbackAt),
        note: null,
      };
    case 'payment_settled':
      return {
        status: 'settled',
        failureReason: null,
        at: stamp(dto.settled_at, fallbackAt),
        note: null,
      };
    case 'payment_failed': {
      const failure = mapFailure(dto.failure_reason, dto.failure_stage);
      return {
        ...failure,
        at: stamp(dto.failed_at, fallbackAt),
        note: dto.failure_reason ? `Bank reason: ${dto.failure_reason}` : null,
      };
    }
    default:
      return null;
  }
}

/** An API error body in the provider's own format, boiled down to something safe to put in a message. */
export function describeProblem(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const problem = body as { title?: unknown; detail?: unknown; errors?: unknown };
  const parts: string[] = [];
  if (typeof problem.detail === 'string') parts.push(problem.detail);
  else if (typeof problem.title === 'string') parts.push(problem.title);
  if (typeof problem.errors === 'object' && problem.errors !== null) {
    for (const [field, messages] of Object.entries(problem.errors as Record<string, unknown>)) {
      const text = Array.isArray(messages) ? messages.join(', ') : String(messages);
      parts.push(`${field}: ${text}`);
    }
  }
  const text = parts.join(' · ').slice(0, 300);
  return text.length > 0 ? text : null;
}

/**
 * Maps a non-2xx answer to creating a payment onto the error the SPA has a designed state for. The distinction that
 * matters to the caller is whether the outcome is *unknown* (a 5xx or a timeout: the payment may exist, retry with the
 * same key) or *definitive* (the provider refused it: nothing was created).
 */
export function throwPaymentError(response: HttpResult): never {
  const detail = describeProblem(response.body);
  switch (response.status) {
    case 400:
      throw new AppError(
        'payment_rejected',
        422,
        detail ? `The bank refused the payment: ${detail}` : 'The bank refused the payment.',
      );
    case 401:
    case 403:
      throw new AppError(
        'provider_error',
        502,
        'The banking provider rejected our credentials or signature for payments. Check the signing key id, the private key and the payment permissions.',
      );
    case 409:
      throw new AppError(
        'conflict',
        409,
        'The bank is still processing an earlier attempt with this key. Wait a moment and try again.',
      );
    case 422:
      throw new AppError(
        'idempotency_conflict',
        422,
        'The bank saw this Idempotency-Key with a different request.',
      );
    case 429: {
      const retry = Number(response.headers['retry-after']);
      throw new AppError('rate_limited', 429, 'The banking provider is rate limiting us.', {
        ...(Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: Math.ceil(retry) } : {}),
      });
    }
    default:
      if (response.status >= 500) {
        throw new AppError('bank_unavailable', 503, 'The bank is not available right now.');
      }
      throw new AppError(
        'provider_error',
        502,
        'The banking provider returned an unexpected answer.',
      );
  }
}

/**
 * The payments credential is a client-credentials token with no refresh and no customer behind it. It is cached until
 * shortly before it expires, and concurrent callers share one request.
 */
export class PaymentsTokenCache {
  private cached: { token: string; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly clock: Clock,
    private readonly fetchToken: (
      ctx: CallContext,
    ) => Promise<{ token: string; expiresInSeconds: number }>,
  ) {}

  async get(ctx: CallContext): Promise<string> {
    const now = this.clock.now().getTime();
    if (this.cached && this.cached.expiresAt - now > 60_000) return this.cached.token;
    this.inflight ??= this.fetchToken(ctx)
      .then(({ token, expiresInSeconds }) => {
        this.cached = {
          token,
          expiresAt: this.clock.now().getTime() + expiresInSeconds * 1000,
        };
        return token;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /** The provider said the token is no good (revoked, or the clock drifted): fetch a new one next time. */
  forget(): void {
    this.cached = null;
  }
}
