import { HttpClient, httpResource } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  DemoActionResponse,
  IDEMPOTENCY_HEADER,
  Payment,
  PaymentList,
  type CreatePaymentRequest,
} from '@ledger-lens/contracts';
import { firstValueFrom } from 'rxjs';
import { EventStream } from '../../core/events/events';

/**
 * Payments for this session. The list comes from the BFF and is kept current by `payment.updated` server events, so a
 * status change that arrives by webhook shows up on every open page without anyone reloading.
 */
@Service()
export class PaymentsData {
  private readonly http = inject(HttpClient);

  readonly payments = httpResource<Payment[]>(() => '/api/payments', {
    defaultValue: [],
    parse: (raw) => PaymentList.parse(raw).items,
  });

  constructor() {
    inject(EventStream)
      .stream.pipe(takeUntilDestroyed())
      .subscribe((event) => {
        if (event.type === 'payment.updated') this.merge(event.payment);
      });
  }

  /** Puts a newer version of a payment into the list, newest first. */
  merge(payment: Payment): void {
    this.payments.value.update((items) => {
      const others = items.filter((item) => item.id !== payment.id);
      return [payment, ...others].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
  }

  /** Rejects with an `ApiError`. The same `key` makes a retry after an unknown outcome the very same payment. */
  async create(request: CreatePaymentRequest, key: string): Promise<Payment> {
    const payment = Payment.parse(
      await firstValueFrom(
        this.http.post('/api/payments', request, { headers: { [IDEMPOTENCY_HEADER]: key } }),
      ),
    );
    this.merge(payment);
    return payment;
  }

  /** "Check now": the BFF asks the bank where the payment stands. */
  async check(id: string): Promise<Payment> {
    const payment = Payment.parse(
      await firstValueFrom(this.http.post(`/api/payments/${encodeURIComponent(id)}/sync`, {})),
    );
    this.merge(payment);
    return payment;
  }

  /** Demo: have the fake bank send its last webhook for this payment again. */
  async replayLastWebhook(paymentId: string): Promise<string> {
    const response = DemoActionResponse.parse(
      await firstValueFrom(
        this.http.post('/api/demo/actions', { action: 'replay_last_webhook', paymentId }),
      ),
    );
    return response.message;
  }
}

/** One id per payment attempt. `randomUUID` needs a secure context; a plain-http LAN address falls back to random bytes. */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
