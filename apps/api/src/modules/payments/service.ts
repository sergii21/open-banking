import {
  maskAccountNumber,
  maskIdentifier,
  normalizeIban,
  type BeneficiaryInput,
  type CreatePaymentRequest,
  type Payment,
  type ProviderId,
  type WebhookAck,
} from '@ledger-lens/contracts';
import type { PaymentRecord } from '../../db/repos';
import { customerRef, newId, sha256Hex } from '../../domain/crypto';
import { applyUpdate, isFinal, type PaymentUpdate } from '../../domain/payment-state';
import { redactHeaders } from '../../domain/redact';
import { AppError, notFound } from '../../errors';
import {
  supportsPayments,
  type BankingProvider,
  type CallContext,
  type CreatePaymentInput,
  type PaymentInitiation,
  type WebhookRequest,
} from '../../providers/port';
import type { ProviderRegistry } from '../../providers/registry';
import type { CoreContext } from '../../types';
import { MODE_BY_PROVIDER } from '../connections/presenter';

/** Nobody has looked at a payment for this long: ask the provider, in case the webhook never came. */
const FIRST_POLL_AFTER_MS = 20_000;
const REPOLL_AFTER_MS = 30_000;

/**
 * A refusal that means the provider created nothing, so the attempt can be forgotten and its key reused. Anything else
 * (a timeout, a 5xx, an answer we could not read) leaves the outcome unknown: the row stays so that retrying with the
 * same key completes the very same payment instead of risking a second one.
 */
const DEFINITIVE_REFUSALS = new Set([
  'payment_rejected',
  'validation_failed',
  'rate_limited',
  'idempotency_conflict',
  'provider_not_available',
  'payments_not_supported',
]);

const WEBHOOK_HEADERS = [
  'content-type',
  'user-agent',
  'x-mock-signature',
  'tl-signature',
  'x-tl-webhook-timestamp',
];

export interface CreateResult {
  payment: Payment;
  replayed: boolean;
}

interface Prepared {
  provider: BankingProvider & PaymentInitiation;
  institutionName: string;
  beneficiary: BeneficiaryInput | null;
  payee: { name: string; identifier: string };
}

function invalid(path: string, message: string): never {
  throw new AppError('validation_failed', 400, message, { errors: [{ path, message }] });
}

/** Normalised so that "de89 3704..." and "DE89370400..." count as the same request. */
function canonicalBeneficiary(beneficiary: BeneficiaryInput | undefined): unknown {
  if (!beneficiary) return null;
  return beneficiary.type === 'iban'
    ? { ...beneficiary, name: beneficiary.name.trim(), iban: normalizeIban(beneficiary.iban) }
    : { ...beneficiary, name: beneficiary.name.trim() };
}

export const hashRequest = (request: CreatePaymentRequest): string =>
  sha256Hex(
    JSON.stringify({
      institutionId: request.institutionId,
      amountMinor: request.amountMinor,
      currency: request.currency,
      beneficiary: canonicalBeneficiary(request.beneficiary),
      reference: request.reference,
    }),
  );

/**
 * Payment initiation. The rules that make it safe to put money in motion from a flaky browser:
 *
 *  - every create carries an Idempotency-Key, and the row exists *before* the provider is called, so a crash or a timeout
 *    can never leave a payment the provider knows about and we do not;
 *  - the provider gets its own idempotency key, stored with the row, so retrying an unknown outcome cannot pay twice;
 *  - provider events (webhooks) and polls both go through one state machine that ignores replays, stragglers and
 *    anything that would move a payment backwards.
 */
export class PaymentService {
  /** Attempts whose provider call is running right now, so a double submit cannot send two of them. */
  private readonly inflight = new Set<string>();

  constructor(
    private readonly core: CoreContext,
    private readonly providers: ProviderRegistry,
  ) {}

  private get returnUri(): string {
    return `${this.core.config.publicUrl}/api/payments/return`;
  }

  private now(): string {
    return this.core.clock.now().toISOString();
  }

  // ------------------------------------------------------------------------------------------ views

  toDto(record: PaymentRecord): Payment {
    let authUrl: string | null = null;
    if (record.status === 'pending' && record.authUrlEnc) {
      try {
        authUrl = this.core.vault.open(record.authUrlEnc, record.id);
      } catch {
        authUrl = null; // sealed with a key we no longer hold: the customer starts a new payment instead
      }
    }
    return {
      id: record.id,
      provider: record.provider,
      mode: MODE_BY_PROVIDER[record.provider],
      institutionId: record.institutionId,
      institutionName: record.institutionName,
      amount: { amountMinor: record.amountMinor, currency: record.currency },
      beneficiaryName: record.beneficiaryName,
      beneficiaryIdentifier: record.beneficiaryIdentifier,
      reference: record.reference,
      status: record.status,
      settlementExpected: record.settlementExpected,
      failureReason: record.failureReason,
      statusHistory: record.statusHistory,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      authUrl,
    };
  }

  list(sessionId: string): Payment[] {
    return this.core.repos.payments.listBySession(sessionId).map((record) => this.toDto(record));
  }

  get(sessionId: string, id: string): PaymentRecord {
    const record = this.core.repos.payments.findForSession(sessionId, id);
    if (!record) throw notFound('Payment');
    return record;
  }

  private publish(record: PaymentRecord): void {
    this.core.events.publish(record.sessionId, {
      type: 'payment.updated',
      payment: this.toDto(record),
    });
  }

  // ------------------------------------------------------------------------------------------ create

  /** Everything that can be checked without the bank: which bank, which currency, how much, and who gets paid. */
  private async prepare(sessionId: string, request: CreatePaymentRequest): Promise<Prepared> {
    const { provider } = this.providers.resolveInstitution(request.institutionId);
    if (!supportsPayments(provider)) {
      throw new AppError('payments_not_supported', 400, 'That bank does not support payments.');
    }
    const institution = (
      await provider.listInstitutions({}, { sessionId, connectionId: null })
    ).find((candidate) => candidate.id === request.institutionId);
    if (!institution?.capabilities.payments) {
      throw new AppError('payments_not_supported', 400, 'That bank does not support payments.');
    }

    if (!institution.currencies.includes(request.currency)) {
      invalid('currency', `${institution.name} pays in ${institution.currencies.join(' or ')}.`);
    }
    if (request.amountMinor > this.core.config.maxPaymentMinor) {
      invalid('amountMinor', 'That is more than this demo allows in one payment.');
    }

    const fixed = provider.fixedPayee(institution.id, request.currency);
    if (institution.fixedPayee) {
      if (!fixed) {
        throw new AppError(
          'payments_not_supported',
          400,
          `${institution.name} cannot receive ${request.currency} payments here.`,
        );
      }
      // The provider pays one account whatever the form says, so what the customer typed for the payee is not used.
      return { provider, institutionName: institution.name, beneficiary: null, payee: fixed };
    }

    const { beneficiary } = request;
    if (!beneficiary) invalid('beneficiary', 'Enter who you are paying.');
    if (request.currency === 'GBP' && beneficiary.type !== 'sort_code_account_number') {
      invalid('beneficiary', 'Pounds go to a UK sort code and account number.');
    }
    if (request.currency === 'EUR' && beneficiary.type !== 'iban') {
      invalid('beneficiary', 'Euros go to an IBAN.');
    }
    return {
      provider,
      institutionName: institution.name,
      beneficiary,
      payee: {
        name: beneficiary.name.trim(),
        identifier:
          beneficiary.type === 'iban'
            ? maskIdentifier(beneficiary.iban)
            : `${beneficiary.sortCode} ${maskAccountNumber(beneficiary.accountNumber)}`,
      },
    };
  }

  async create(
    sessionId: string,
    idempotencyKey: string,
    request: CreatePaymentRequest,
    psuIp?: string,
  ): Promise<CreateResult> {
    const requestHash = hashRequest(request);
    const existing = this.core.repos.payments.findByIdempotencyKey(sessionId, idempotencyKey);
    if (existing && existing.requestHash !== requestHash) {
      throw new AppError(
        'idempotency_conflict',
        422,
        'That Idempotency-Key was already used for a different payment. Start a new payment instead.',
      );
    }
    if (existing?.providerPaymentId) {
      return { payment: this.toDto(existing), replayed: true };
    }

    const prepared = await this.prepare(sessionId, request);
    const now = this.now();
    // An earlier attempt with this key never reached the provider: finish that one rather than starting another.
    const record: PaymentRecord = existing ?? {
      id: newId('pay'),
      sessionId,
      provider: prepared.provider.id,
      institutionId: request.institutionId,
      institutionName: prepared.institutionName,
      idempotencyKey,
      requestHash,
      providerIdempotencyKey: newId('idem'),
      providerPaymentId: null,
      amountMinor: request.amountMinor,
      currency: request.currency,
      beneficiaryName: prepared.payee.name,
      beneficiaryIdentifier: prepared.payee.identifier,
      reference: request.reference,
      status: 'pending',
      settlementExpected: true,
      failureReason: null,
      statusHistory: [{ status: 'pending', at: now, note: 'Payment created' }],
      authUrlEnc: null,
      createdAt: now,
      updatedAt: now,
      lastCheckedAt: null,
    };
    if (!existing) this.core.repos.payments.insert(record);

    const payment = await this.submit(record, prepared, psuIp);
    return { payment, replayed: false };
  }

  /** Sends the payment to the provider and records what it said. */
  private async submit(
    record: PaymentRecord,
    prepared: Prepared,
    psuIp: string | undefined,
  ): Promise<Payment> {
    if (this.inflight.has(record.id)) {
      throw new AppError(
        'conflict',
        409,
        'This payment is already being sent to the bank. Wait a moment before trying again.',
      );
    }
    this.inflight.add(record.id);

    const input: CreatePaymentInput = {
      clientReference: record.id,
      institutionId: record.institutionId,
      amount: { amountMinor: record.amountMinor, currency: record.currency },
      beneficiary: prepared.beneficiary,
      reference: record.reference,
      idempotencyKey: record.providerIdempotencyKey,
      returnUri: this.returnUri,
      customerRef: customerRef(record.sessionId),
      ...(psuIp ? { psuIp } : {}),
    };
    const call: CallContext = { sessionId: record.sessionId, connectionId: null };

    try {
      const created = await prepared.provider.createPayment(input, call);
      const now = this.now();
      this.core.repos.payments.update(
        record.id,
        {
          providerPaymentId: created.providerPaymentId,
          settlementExpected: created.settlementExpected,
          authUrlEnc: this.core.vault.seal(created.authUrl, record.id),
        },
        now,
      );
      const stored = this.core.repos.payments.findById(record.id) ?? record;
      // A provider that answers with a state beyond "waiting for the customer" is applied like any other report.
      const settled =
        created.status === 'pending'
          ? stored
          : this.applyReport(stored, {
              status: created.status,
              failureReason: null,
              at: now,
              note: null,
            }).record;
      this.publish(settled);
      return this.toDto(settled);
    } catch (error) {
      if (error instanceof AppError && DEFINITIVE_REFUSALS.has(error.code)) {
        this.core.repos.payments.delete(record.id);
      }
      throw error;
    } finally {
      this.inflight.delete(record.id);
    }
  }

  // ------------------------------------------------------------------------------------------ progress

  /**
   * Applies a provider report to a payment through the state machine. Safe to call with anything: replays and
   * out-of-order reports change nothing. Persists and announces only when the state really moved.
   */
  private applyReport(
    record: PaymentRecord,
    update: PaymentUpdate,
  ): { record: PaymentRecord; changed: boolean } {
    const now = this.now();
    const transition = applyUpdate(
      {
        status: record.status,
        failureReason: record.failureReason,
        settlementExpected: record.settlementExpected,
        statusHistory: record.statusHistory,
      },
      update,
    );
    if (!transition.changed) {
      this.core.repos.payments.touchChecked(record.id, now);
      return { record: { ...record, lastCheckedAt: now }, changed: false };
    }
    this.core.repos.payments.update(
      record.id,
      {
        status: transition.state.status,
        failureReason: transition.state.failureReason,
        statusHistory: transition.state.statusHistory,
        lastCheckedAt: now,
        // The bank link carries a one-time token; once the customer has moved on there is no reason to keep it.
        ...(transition.state.status === 'pending' ? {} : { authUrlEnc: null }),
      },
      now,
    );
    const updated = this.core.repos.payments.findById(record.id) ?? record;
    this.publish(updated);
    return { record: updated, changed: true };
  }

  private providerFor(record: PaymentRecord): (BankingProvider & PaymentInitiation) | null {
    if (!this.providers.has(record.provider)) return null;
    const provider = this.providers.get(record.provider);
    return supportsPayments(provider) ? provider : null;
  }

  /** Asks the provider where the payment stands and applies the answer. */
  private async poll(record: PaymentRecord, psuIp?: string): Promise<PaymentRecord> {
    const provider = this.providerFor(record);
    if (!provider || !record.providerPaymentId) return record;
    const call: CallContext = {
      sessionId: record.sessionId,
      connectionId: null,
      ...(psuIp ? { psuIp } : {}),
    };
    const update = await provider.getPayment(record.providerPaymentId, call);
    return this.applyReport(record, update).record;
  }

  /** "Check now": the customer asks us to look at the bank again. */
  async sync(sessionId: string, id: string, psuIp?: string): Promise<Payment> {
    const record = this.get(sessionId, id);
    if (isFinal(record)) return this.toDto(record);
    return this.toDto(await this.poll(record, psuIp));
  }

  /**
   * Where the bank sends the browser back. Public, and keyed by the provider's payment id (unguessable) rather than by
   * cookie. Whatever the query says, it only decides which page to show: the truth comes from asking the provider.
   */
  async handleReturn(query: Record<string, string | undefined>, psuIp?: string): Promise<string> {
    const providerPaymentId = query['payment_id'];
    const record = providerPaymentId
      ? this.core.repos.payments.findByProviderPaymentId(providerPaymentId)
      : undefined;
    if (!record) return '/payments';

    try {
      await this.poll(record, psuIp);
    } catch (error) {
      // The page shows the last state we know and the polling fallback keeps trying.
      this.core.log.warn(
        { provider: record.provider, code: error instanceof AppError ? error.code : 'unexpected' },
        'checking a payment on return failed',
      );
    }
    const abandoned = query['error'] === 'tl_hpp_abandoned' ? '?abandoned=1' : '';
    return `/payments/${record.id}/result${abandoned}`;
  }

  // ------------------------------------------------------------------------------------------ webhooks

  async handleWebhook(providerId: ProviderId, request: WebhookRequest): Promise<WebhookAck> {
    const provider = this.providers.get(providerId);
    if (!supportsPayments(provider)) {
      throw new AppError(
        'payments_not_supported',
        404,
        'That provider does not send payment webhooks.',
      );
    }
    const started = performance.now();
    const event = await provider.verifyWebhook(request);
    if (!event.providerPaymentId) return { status: 'unsupported_event' };

    const result = this.core.db.transaction(() => {
      const record = this.core.repos.payments.findByProviderPaymentId(
        event.providerPaymentId,
        providerId,
      );
      // Not ours (or not stored yet: the poll fallback will catch up). Acknowledge so the provider stops retrying.
      if (!record) return { status: 'unknown_payment' as const, record: null, changed: false };
      if (this.core.repos.webhookEvents.has(providerId, event.eventId)) {
        return { status: 'duplicate' as const, record, changed: false };
      }

      let status: WebhookAck['status'] = 'unsupported_event';
      let changed = false;
      let latest = record;
      if (event.update) {
        const applied = this.applyReport(record, event.update);
        latest = applied.record;
        changed = applied.changed;
        status = changed ? 'applied' : 'ignored';
      }
      this.core.repos.webhookEvents.insert({
        provider: providerId,
        eventId: event.eventId,
        eventType: event.type,
        providerPaymentId: event.providerPaymentId,
        payload: JSON.stringify(event.payload),
        receivedAt: this.now(),
        outcome: status,
      });
      return { status, record: latest, changed };
    });

    if (result.record) {
      this.recordInboundCall(
        providerId,
        request,
        event.type,
        event.payload,
        result.status,
        started,
        result.record,
      );
    }
    return { status: result.status };
  }

  /** Files the webhook with the Inspector under the payment's session, so the reader sees it arrive. */
  private recordInboundCall(
    provider: ProviderId,
    request: WebhookRequest,
    type: string,
    payload: unknown,
    status: WebhookAck['status'],
    started: number,
    record: PaymentRecord,
  ): void {
    const headers: Record<string, string> = {};
    for (const name of WEBHOOK_HEADERS) {
      const value = request.headers[name];
      const text = Array.isArray(value) ? value[0] : value;
      if (text) headers[name] = text;
    }
    this.core.inspector.record(record.sessionId, {
      id: newId('call'),
      at: this.now(),
      provider,
      label: `Webhook: ${type}`,
      direction: 'inbound',
      method: request.method,
      url: request.path,
      status: 200,
      durationMs: Math.round(performance.now() - started),
      request: { headers: redactHeaders(headers), body: payload },
      response: { headers: {}, body: { status } },
      error: null,
      truncated: false,
      connectionId: null,
    });
  }

  // ------------------------------------------------------------------------------------------ the clock

  /**
   * The fallback for webhooks that never arrive (no tunnel, a provider outage, a restart): look at payments nobody has
   * heard about lately, and give up on ones the customer never approved. Runs every few seconds.
   */
  async pollDue(): Promise<void> {
    const nowMs = this.core.clock.now().getTime();
    const iso = (ms: number): string => new Date(ms).toISOString();
    const { payments, webhookEvents } = this.core.repos;
    const approvalMs = this.core.config.paymentApprovalMinutes * 60_000;

    payments.deleteUnsentBefore(iso(nowMs - approvalMs));
    webhookEvents.pruneBefore(iso(nowMs - this.core.config.webhookMaxAgeSeconds * 1000));

    for (const record of payments.listDueForPoll(
      iso(nowMs - FIRST_POLL_AFTER_MS),
      iso(nowMs - REPOLL_AFTER_MS),
    )) {
      try {
        await this.poll(record);
      } catch (error) {
        this.core.log.warn(
          {
            provider: record.provider,
            code: error instanceof AppError ? error.code : 'unexpected',
          },
          'polling a payment failed',
        );
        payments.touchChecked(record.id, this.now());
      }
    }

    // The bank's approval window has passed: ask once more, then stop waiting.
    for (const record of payments.listPendingBefore(iso(nowMs - approvalMs))) {
      let current = record;
      try {
        current = await this.poll(record);
      } catch {
        // Unreachable bank: expire locally all the same, the link has lapsed.
      }
      if (current.status === 'pending') {
        this.applyReport(current, {
          status: 'failed',
          failureReason: 'expired',
          at: this.now(),
          note: 'The approval window ended before the payment was approved',
        });
      }
    }
  }
}
