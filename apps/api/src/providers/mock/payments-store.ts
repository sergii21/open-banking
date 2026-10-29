import type { Db } from '../../db/database';
import type { ExecutedPayment } from './dataset';

export type MockPaymentStatus =
  'authorization_required' | 'authorizing' | 'authorized' | 'executed' | 'settled' | 'failed';

/** What the demo customer chooses on the bank's page; the names are TrueLayer's mock-bank usernames. */
export type MockOutcome = 'test_executed' | 'test_authorisation_failed' | 'test_execution_rejected';

export interface MockPayment {
  id: string;
  institution: string;
  idempotencyKey: string;
  requestHash: string;
  amountMinor: number;
  currency: string;
  beneficiaryName: string;
  beneficiaryIdentifier: string;
  reference: string;
  returnUri: string;
  customerRef: string;
  settlementExpected: boolean;
  resourceTokenHash: string;
  status: MockPaymentStatus;
  failureStage: string | null;
  failureReason: string | null;
  persona: string | null;
  outcome: MockOutcome | null;
  createdAt: string;
  expiresAt: string;
  executedAt: string | null;
  settledAt: string | null;
  failedAt: string | null;
  nextStatus: 'executed' | 'settled' | 'failed' | null;
  nextAt: string | null;
  updatedAt: string;
}

interface PaymentRow {
  id: string;
  institution: string;
  idempotency_key: string;
  request_hash: string;
  amount_minor: number;
  currency: string;
  beneficiary_name: string;
  beneficiary_identifier: string;
  reference: string;
  return_uri: string;
  customer_ref: string;
  settlement_expected: number;
  resource_token_hash: string;
  status: string;
  failure_stage: string | null;
  failure_reason: string | null;
  persona: string | null;
  outcome: string | null;
  created_at: string;
  expires_at: string;
  executed_at: string | null;
  settled_at: string | null;
  failed_at: string | null;
  next_status: string | null;
  next_at: string | null;
  updated_at: string;
}

const toPayment = (row: PaymentRow): MockPayment => ({
  id: row.id,
  institution: row.institution,
  idempotencyKey: row.idempotency_key,
  requestHash: row.request_hash,
  amountMinor: row.amount_minor,
  currency: row.currency,
  beneficiaryName: row.beneficiary_name,
  beneficiaryIdentifier: row.beneficiary_identifier,
  reference: row.reference,
  returnUri: row.return_uri,
  customerRef: row.customer_ref,
  settlementExpected: row.settlement_expected === 1,
  resourceTokenHash: row.resource_token_hash,
  status: row.status as MockPaymentStatus,
  failureStage: row.failure_stage,
  failureReason: row.failure_reason,
  persona: row.persona,
  outcome: row.outcome as MockOutcome | null,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  executedAt: row.executed_at,
  settledAt: row.settled_at,
  failedAt: row.failed_at,
  nextStatus: row.next_status as MockPayment['nextStatus'],
  nextAt: row.next_at,
  updatedAt: row.updated_at,
});

export type MockPaymentPatch = Partial<
  Pick<
    MockPayment,
    | 'status'
    | 'failureStage'
    | 'failureReason'
    | 'persona'
    | 'outcome'
    | 'executedAt'
    | 'settledAt'
    | 'failedAt'
    | 'nextStatus'
    | 'nextAt'
  >
>;

const COLUMNS: Record<keyof MockPaymentPatch, string> = {
  status: 'status',
  failureStage: 'failure_stage',
  failureReason: 'failure_reason',
  persona: 'persona',
  outcome: 'outcome',
  executedAt: 'executed_at',
  settledAt: 'settled_at',
  failedAt: 'failed_at',
  nextStatus: 'next_status',
  nextAt: 'next_at',
};

export interface OutboxRow {
  id: string;
  paymentId: string;
  eventId: string;
  type: string;
  body: string;
  createdAt: string;
  attempts: number;
  nextAttemptAt: string;
  deliveredAt: string | null;
  lastStatus: number | null;
}

interface OutboxDbRow {
  id: string;
  payment_id: string;
  event_id: string;
  type: string;
  body: string;
  created_at: string;
  attempts: number;
  next_attempt_at: string;
  delivered_at: string | null;
  last_status: number | null;
}

const toOutbox = (row: OutboxDbRow): OutboxRow => ({
  id: row.id,
  paymentId: row.payment_id,
  eventId: row.event_id,
  type: row.type,
  body: row.body,
  createdAt: row.created_at,
  attempts: row.attempts,
  nextAttemptAt: row.next_attempt_at,
  deliveredAt: row.delivered_at,
  lastStatus: row.last_status,
});

/** The fake bank's payment tables and its webhook outbox. Only providers/mock may use this. */
export class MockPaymentsStore {
  constructor(private readonly db: Db) {}

  insert(payment: MockPayment): void {
    this.db.run(
      `INSERT INTO mock_payments (id, institution, idempotency_key, request_hash, amount_minor, currency, beneficiary_name,
         beneficiary_identifier, reference, return_uri, customer_ref, settlement_expected, resource_token_hash, status,
         failure_stage, failure_reason, persona, outcome, created_at, expires_at, executed_at, settled_at, failed_at,
         next_status, next_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      payment.id,
      payment.institution,
      payment.idempotencyKey,
      payment.requestHash,
      payment.amountMinor,
      payment.currency,
      payment.beneficiaryName,
      payment.beneficiaryIdentifier,
      payment.reference,
      payment.returnUri,
      payment.customerRef,
      payment.settlementExpected ? 1 : 0,
      payment.resourceTokenHash,
      payment.status,
      payment.failureStage,
      payment.failureReason,
      payment.persona,
      payment.outcome,
      payment.createdAt,
      payment.expiresAt,
      payment.executedAt,
      payment.settledAt,
      payment.failedAt,
      payment.nextStatus,
      payment.nextAt,
      payment.updatedAt,
    );
  }

  get(id: string): MockPayment | undefined {
    const row = this.db.get<PaymentRow>('SELECT * FROM mock_payments WHERE id = ?', id);
    return row ? toPayment(row) : undefined;
  }

  findByIdempotencyKey(key: string): MockPayment | undefined {
    const row = this.db.get<PaymentRow>(
      'SELECT * FROM mock_payments WHERE idempotency_key = ?',
      key,
    );
    return row ? toPayment(row) : undefined;
  }

  update(id: string, patch: MockPaymentPatch, now: string): void {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    for (const [key, value] of Object.entries(patch) as [keyof MockPaymentPatch, string | null][]) {
      sets.push(`${COLUMNS[key]} = ?`);
      params.push(value ?? null);
    }
    if (sets.length === 0) return;
    this.db.run(
      `UPDATE mock_payments SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`,
      ...params,
      now,
      id,
    );
  }

  /** Transitions the bank scheduled for itself (execute, settle, reject) that have come due. */
  due(now: string): MockPayment[] {
    return this.db
      .all<PaymentRow>(
        `SELECT * FROM mock_payments WHERE next_at IS NOT NULL AND next_at <= ? ORDER BY next_at ASC, id ASC`,
        now,
      )
      .map(toPayment);
  }

  /** Payments the customer never approved within the bank's window. */
  expired(now: string): MockPayment[] {
    return this.db
      .all<PaymentRow>(
        `SELECT * FROM mock_payments WHERE status IN ('authorization_required','authorizing') AND expires_at <= ?`,
        now,
      )
      .map(toPayment);
  }

  /** Payments that moved money for a customer, as the dataset wants them. */
  executedFor(institution: string, customerRef: string): (ExecutedPayment & { persona: string })[] {
    return this.db
      .all<PaymentRow>(
        `SELECT * FROM mock_payments WHERE institution = ? AND customer_ref = ? AND status IN ('executed','settled')
           AND executed_at IS NOT NULL AND persona IS NOT NULL ORDER BY executed_at ASC, id ASC`,
        institution,
        customerRef,
      )
      .map((row) => ({
        id: row.id,
        persona: row.persona ?? '',
        accountCurrency: row.currency,
        amountMinor: row.amount_minor,
        beneficiaryName: row.beneficiary_name,
        reference: row.reference,
        executedAt: row.executed_at ?? row.created_at,
      }));
  }

  // ------------------------------------------------------------------------------------------ outbox

  enqueue(
    input: { id: string; paymentId: string; eventId: string; type: string; body: string },
    now: string,
  ): void {
    this.db.run(
      `INSERT INTO mock_outbox (id, payment_id, event_id, type, body, created_at, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.paymentId,
      input.eventId,
      input.type,
      input.body,
      now,
      now,
    );
  }

  dueOutbox(now: string, maxAttempts: number, limit = 20): OutboxRow[] {
    return this.db
      .all<OutboxDbRow>(
        `SELECT * FROM mock_outbox WHERE delivered_at IS NULL AND attempts < ? AND next_attempt_at <= ?
         ORDER BY created_at ASC, id ASC LIMIT ?`,
        maxAttempts,
        now,
        limit,
      )
      .map(toOutbox);
  }

  markDelivered(id: string, status: number, now: string): void {
    this.db.run(
      `UPDATE mock_outbox SET delivered_at = ?, last_status = ?, attempts = attempts + 1 WHERE id = ?`,
      now,
      status,
      id,
    );
  }

  markAttemptFailed(id: string, status: number | null, nextAttemptAt: string): void {
    this.db.run(
      `UPDATE mock_outbox SET attempts = attempts + 1, last_status = ?, next_attempt_at = ? WHERE id = ?`,
      status,
      nextAttemptAt,
      id,
    );
  }

  /** The most recent event delivered for a payment, which the demo's "replay" sends again. */
  lastDelivered(providerPaymentId: string): OutboxRow | undefined {
    const row = this.db.get<OutboxDbRow>(
      `SELECT * FROM mock_outbox WHERE payment_id = ? AND delivered_at IS NOT NULL ORDER BY delivered_at DESC, id DESC LIMIT 1`,
      providerPaymentId,
    );
    return row ? toOutbox(row) : undefined;
  }

  outboxFor(paymentId: string): OutboxRow[] {
    return this.db
      .all<OutboxDbRow>(
        'SELECT * FROM mock_outbox WHERE payment_id = ? ORDER BY created_at ASC, id ASC',
        paymentId,
      )
      .map(toOutbox);
  }
}
