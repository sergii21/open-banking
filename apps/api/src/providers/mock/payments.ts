import { createHmac } from 'node:crypto';
import type { Clock } from '../../clock';
import { newId, safeEqual, sha256Hex } from '../../domain/crypto';
import {
  findMockInstitution,
  settlesPayments,
  type MockInstitution,
  type Persona,
} from './institutions';
import type { MockPayment, MockOutcome, MockPaymentsStore } from './payments-store';
import { signMockWebhook } from './signature';

/** Webhook deliveries that fail are retried with growing gaps, then dropped, as real providers do. */
const MAX_DELIVERY_ATTEMPTS = 8;
const MAX_BACKOFF_SECONDS = 120;
export const API_TOKEN_TTL_SECONDS = 3600;

export interface MockPaymentsOptions {
  store: MockPaymentsStore;
  clock: Clock;
  /** How long the bank takes between steps (authorised, executed, settled). */
  stepSeconds: number;
  /** How long a payment waits for the customer before the bank gives up on it. */
  approvalMinutes: number;
  webhookSecret: string;
  /** The only return URI this client may register. */
  allowedReturnUri: string;
  /** What the customer can still spend on the account the payment would leave: the bank checks this when it executes. */
  availableMinor(institution: MockInstitution, persona: Persona, customerRef: string): number;
  /** POSTs a signed webhook to the app and answers what it said (`status` 0 when it could not be reached). */
  deliver(body: string, signature: string): Promise<DeliveryResult>;
}

export interface DeliveryResult {
  status: number;
  /** The `status` field of the app's JSON answer (`applied`, `duplicate`, ...), when it sent one. */
  ack: string | null;
}

export interface NewMockPayment {
  institution: MockInstitution;
  idempotencyKey: string;
  requestHash: string;
  amountMinor: number;
  currency: string;
  beneficiaryName: string;
  beneficiaryIdentifier: string;
  reference: string;
  returnUri: string;
  customerRef: string;
}

export type CreateResult =
  | { kind: 'created' | 'replayed'; payment: MockPayment; resourceToken: string }
  | { kind: 'conflict' };

type EventType = 'payment_authorized' | 'payment_executed' | 'payment_settled' | 'payment_failed';

/**
 * The fake bank's payment engine: what a real bank and provider do after the customer is sent away. It advances payments
 * on its own clock (`tick`), and tells the app about each step with a signed webhook that may arrive twice or late.
 *
 * Outcomes are the ones TrueLayer's mock bank offers, chosen by the customer on the bank's page:
 *  - `test_executed`: authorised at once, executed one step later, settled one step after that when the payee settles;
 *  - `test_authorisation_failed`: the customer fails strong customer authentication;
 *  - `test_execution_rejected`: authorised, then the bank refuses to execute;
 * and independently of those, a payment bigger than what the account holds is rejected for insufficient funds.
 */
export class MockPaymentsEngine {
  constructor(private readonly options: MockPaymentsOptions) {}

  private now(): string {
    return this.options.clock.now().toISOString();
  }

  private after(seconds: number): string {
    return new Date(this.options.clock.now().getTime() + seconds * 1000).toISOString();
  }

  /** Derived, not stored: replaying a creation request has to give back the very same resource token. */
  resourceTokenFor(paymentId: string): string {
    const mac = createHmac('sha256', this.options.webhookSecret)
      .update(`resource-token:${paymentId}`)
      .digest('base64url');
    return `mbk_pay_${mac}`;
  }

  hasValidResourceToken(payment: MockPayment, token: string): boolean {
    return safeEqual(sha256Hex(token), payment.resourceTokenHash);
  }

  /** A client-credentials token for the payments API. The expiry is signed into it, so the bank needs no table for tokens. */
  issueApiToken(): { token: string; expiresInSeconds: number } {
    const expiresAt = Math.floor(this.options.clock.now().getTime() / 1000) + API_TOKEN_TTL_SECONDS;
    const mac = createHmac('sha256', this.options.webhookSecret)
      .update(`api-token:${expiresAt}`)
      .digest('base64url');
    return { token: `mbk_pt_${expiresAt}.${mac}`, expiresInSeconds: API_TOKEN_TTL_SECONDS };
  }

  checkApiToken(token: string): 'ok' | 'expired' | 'invalid' {
    const match = /^mbk_pt_(\d+)\.([A-Za-z0-9_-]+)$/.exec(token);
    if (!match) return 'invalid';
    const expected = createHmac('sha256', this.options.webhookSecret)
      .update(`api-token:${match[1]}`)
      .digest('base64url');
    if (!safeEqual(match[2] ?? '', expected)) return 'invalid';
    return Number(match[1]) * 1000 <= this.options.clock.now().getTime() ? 'expired' : 'ok';
  }

  get(id: string): MockPayment | undefined {
    return this.options.store.get(id);
  }

  create(input: NewMockPayment): CreateResult {
    const { store } = this.options;
    const existing = store.findByIdempotencyKey(input.idempotencyKey);
    if (existing) {
      return existing.requestHash === input.requestHash
        ? {
            kind: 'replayed',
            payment: existing,
            resourceToken: this.resourceTokenFor(existing.id),
          }
        : { kind: 'conflict' };
    }
    const now = this.now();
    const id = newId('mpay');
    const resourceToken = this.resourceTokenFor(id);
    const payment: MockPayment = {
      id,
      institution: input.institution.slug,
      idempotencyKey: input.idempotencyKey,
      requestHash: input.requestHash,
      amountMinor: input.amountMinor,
      currency: input.currency,
      beneficiaryName: input.beneficiaryName,
      beneficiaryIdentifier: input.beneficiaryIdentifier,
      reference: input.reference,
      returnUri: input.returnUri,
      customerRef: input.customerRef,
      settlementExpected: settlesPayments(input.institution),
      resourceTokenHash: sha256Hex(resourceToken),
      status: 'authorization_required',
      failureStage: null,
      failureReason: null,
      persona: null,
      outcome: null,
      createdAt: now,
      expiresAt: this.after(this.options.approvalMinutes * 60),
      executedAt: null,
      settledAt: null,
      failedAt: null,
      nextStatus: null,
      nextAt: null,
      updatedAt: now,
    };
    store.insert(payment);
    return { kind: 'created', payment, resourceToken };
  }

  /** The customer opened the bank's page: the payment is now being authorised. */
  opened(payment: MockPayment): MockPayment {
    if (payment.status !== 'authorization_required') return payment;
    this.options.store.update(payment.id, { status: 'authorizing' }, this.now());
    return { ...payment, status: 'authorizing' };
  }

  /** The bank's hosted page could not be served (an outage): the payment cannot be completed. */
  fail(payment: MockPayment, stage: string, reason: string): void {
    const now = this.now();
    this.options.store.update(
      payment.id,
      {
        status: 'failed',
        failureStage: stage,
        failureReason: reason,
        failedAt: now,
        nextStatus: null,
        nextAt: null,
      },
      now,
    );
    this.emit('payment_failed', { ...payment, failureStage: stage, failureReason: reason }, now);
  }

  cancel(payment: MockPayment): void {
    this.fail(payment, 'authorization_required', 'canceled');
  }

  /** The customer chose who they are and what should happen, and approved (or failed to). */
  approve(
    payment: MockPayment,
    persona: Persona,
    outcome: MockOutcome,
    institution: MockInstitution,
  ): void {
    if (outcome === 'test_authorisation_failed') {
      this.options.store.update(payment.id, { persona: persona.id, outcome }, this.now());
      this.fail(
        { ...payment, persona: persona.id, outcome },
        'authorizing',
        'authorization_failed',
      );
      return;
    }

    const now = this.now();
    const available = this.options.availableMinor(institution, persona, payment.customerRef);
    const rejection =
      outcome === 'test_execution_rejected'
        ? 'rejected'
        : payment.amountMinor > available
          ? 'insufficient_funds'
          : null;

    this.options.store.update(
      payment.id,
      {
        status: 'authorized',
        persona: persona.id,
        outcome,
        failureStage: rejection ? 'authorized' : null,
        failureReason: rejection,
        nextStatus: rejection ? 'failed' : 'executed',
        nextAt: this.after(this.options.stepSeconds),
      },
      now,
    );
    this.emit('payment_authorized', { ...payment, status: 'authorized' }, now);
  }

  // ------------------------------------------------------------------------------------------ the clock

  /** Applies every step that has come due, gives up on payments nobody approved, and delivers pending webhooks. */
  async tick(): Promise<void> {
    const { store } = this.options;
    const now = this.now();

    for (const payment of store.expired(now)) {
      this.fail(payment, payment.status, 'expired');
    }

    for (const payment of store.due(now)) {
      switch (payment.nextStatus) {
        case 'executed': {
          const next = payment.settlementExpected;
          store.update(
            payment.id,
            {
              status: 'executed',
              executedAt: now,
              nextStatus: next ? 'settled' : null,
              nextAt: next ? this.after(this.options.stepSeconds) : null,
            },
            now,
          );
          this.emit('payment_executed', { ...payment, status: 'executed', executedAt: now }, now);
          break;
        }
        case 'settled':
          store.update(
            payment.id,
            { status: 'settled', settledAt: now, nextStatus: null, nextAt: null },
            now,
          );
          this.emit('payment_settled', { ...payment, status: 'settled', settledAt: now }, now);
          break;
        case 'failed':
          store.update(
            payment.id,
            { status: 'failed', failedAt: now, nextStatus: null, nextAt: null },
            now,
          );
          this.emit('payment_failed', { ...payment, status: 'failed', failedAt: now }, now);
          break;
        case null:
          store.update(payment.id, { nextAt: null }, now);
          break;
      }
    }

    await this.deliverDue();
  }

  // ------------------------------------------------------------------------------------------ webhooks

  private emit(type: EventType, payment: MockPayment, now: string): void {
    const institution = findMockInstitution(payment.institution);
    const body = {
      type,
      event_version: 1,
      event_id: newId('evt'),
      payment_id: payment.id,
      payment_method: {
        type: 'bank_transfer',
        provider_id: `mock-payments-${institution?.locale ?? 'de'}-redirect`,
      },
      ...(type === 'payment_authorized' ? { authorized_at: now } : {}),
      ...(type === 'payment_executed' ? { executed_at: payment.executedAt ?? now } : {}),
      ...(type === 'payment_settled' ? { settled_at: payment.settledAt ?? now } : {}),
      ...(type === 'payment_failed'
        ? {
            failed_at: now,
            failure_stage: payment.failureStage,
            failure_reason: payment.failureReason,
          }
        : {}),
      metadata: { reference: payment.reference },
    };
    this.options.store.enqueue(
      {
        id: newId('mob'),
        paymentId: payment.id,
        eventId: body.event_id,
        type,
        body: JSON.stringify(body),
      },
      now,
    );
  }

  private async send(body: string): Promise<DeliveryResult> {
    const seconds = Math.floor(this.options.clock.now().getTime() / 1000);
    try {
      return await this.options.deliver(
        body,
        signMockWebhook(this.options.webhookSecret, seconds, body),
      );
    } catch {
      return { status: 0, ack: null };
    }
  }

  async deliverDue(): Promise<void> {
    const { store } = this.options;
    const now = this.now();
    for (const row of store.dueOutbox(now, MAX_DELIVERY_ATTEMPTS)) {
      const { status } = await this.send(row.body);
      if (status >= 200 && status < 300) {
        store.markDelivered(row.id, status, now);
      } else {
        const backoff = Math.min(2 ** row.attempts, MAX_BACKOFF_SECONDS);
        store.markAttemptFailed(row.id, status || null, this.after(backoff));
      }
    }
  }

  /**
   * The demo's "send the last webhook again". The body is identical (same event id), signed afresh so it passes the
   * freshness check: what the receiver must get right is that the same event applied twice changes nothing.
   */
  async replayLast(
    paymentId: string,
  ): Promise<({ type: string; eventId: string } & DeliveryResult) | null> {
    const last = this.options.store.lastDelivered(paymentId);
    if (!last) return null;
    return { type: last.type, eventId: last.eventId, ...(await this.send(last.body)) };
  }
}
