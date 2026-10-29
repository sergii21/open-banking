import { httpResource } from '@angular/common/http';
import { Component, computed, DestroyRef, inject, input, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatProgressSpinner } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { RouterLink } from '@angular/router';
import { minorToDecimalString, Payment } from '@ledger-lens/contracts';
import { describeError, toApiError } from '../../core/api/api-error';
import { Data } from '../../core/data/data';
import { EventStream } from '../../core/events/events';
import { SessionService } from '../../core/session/session';
import { formatDateTime } from '../../shared/format';
import { Money } from '../../shared/money/money';
import { Skeleton } from '../../shared/states/skeleton';
import { StateCard } from '../../shared/states/state-card';
import { StatusChip, type Tone } from '../../shared/status-chip/status-chip';
import { PaymentTimeline } from './payment-timeline';
import { PaymentsData } from './payments-data';
import { failureCopy, isFinished, statusView } from './payment-view';

interface Outcome {
  icon: string;
  tone: Tone;
  title: string;
  message: string;
}

/** Without the event stream the page asks the BFF now and then instead. */
const FALLBACK_REFRESH_MS = 5000;

/**
 * One payment, live. The page is where the customer lands after the bank (`/payments/:id/result`) and where they
 * watch the rest happen: the BFF pushes each change by server-sent event as the bank's webhook arrives.
 */
@Component({
  selector: 'll-payment-detail',
  imports: [
    MatButton,
    MatIcon,
    MatProgressSpinner,
    Money,
    PaymentTimeline,
    RouterLink,
    Skeleton,
    StateCard,
    StatusChip,
  ],
  templateUrl: './payment-detail.html',
})
export class PaymentDetail {
  private readonly data = inject(PaymentsData);
  private readonly accounts = inject(Data);
  private readonly session = inject(SessionService);
  private readonly events = inject(EventStream);
  private readonly snackBar = inject(MatSnackBar);

  readonly id = input.required<string>();
  /** `?abandoned=1`: the bank sent the customer back without them approving. */
  readonly abandoned = input<string>();

  protected readonly resource = httpResource<Payment>(
    () => `/api/payments/${encodeURIComponent(this.id())}`,
    { parse: (raw) => Payment.parse(raw) },
  );
  protected readonly payment = computed(() =>
    this.resource.hasValue() ? this.resource.value() : undefined,
  );

  protected readonly loading = computed(
    () => this.resource.status() === 'loading' && !this.resource.hasValue(),
  );
  protected readonly failure = computed(() => describeError(this.resource.error()));
  protected readonly status = computed(() => {
    const payment = this.payment();
    return payment ? statusView(payment) : null;
  });
  protected readonly finished = computed(() => {
    const payment = this.payment();
    return payment ? isFinished(payment) : false;
  });
  protected readonly createdAt = computed(() => {
    const payment = this.payment();
    return payment ? formatDateTime(payment.createdAt) : '';
  });

  protected readonly outcome = computed<Outcome | null>(() => {
    const payment = this.payment();
    if (!payment) return null;
    switch (payment.status) {
      case 'pending':
        return {
          icon: 'hourglass_top',
          tone: 'warning',
          title: 'Waiting for your approval',
          message: this.abandoned()
            ? 'You left your bank before approving, so nothing has been paid. You can pick up where you left off.'
            : 'Approve the payment on your bank’s page. You’ll come back here, and this page updates by itself.',
        };
      case 'authorised':
        return {
          icon: 'verified_user',
          tone: 'info',
          title: 'Approved. The bank is processing it',
          message: 'The bank has your approval and will carry out the payment in a moment.',
        };
      case 'executed':
        return payment.settlementExpected
          ? {
              icon: 'send',
              tone: 'info',
              title: 'The bank has sent it',
              message: 'Waiting for the money to settle in the payee’s account.',
            }
          : {
              icon: 'check_circle',
              tone: 'success',
              title: 'Sent',
              message:
                'The bank accepted and executed the payment. This bank has no separate settlement step.',
            };
      case 'settled':
        return {
          icon: 'check_circle',
          tone: 'success',
          title: 'Payment complete',
          message: 'The money has arrived in the payee’s account.',
        };
      case 'failed':
      case 'cancelled': {
        const copy = failureCopy(payment.failureReason);
        return { icon: copy.icon, tone: 'error', title: copy.title, message: copy.message };
      }
    }
  });

  /** Starting again after a failure: the same payment, ready to send, minus the payee details we never kept. */
  protected readonly again = computed(() => {
    const payment = this.payment();
    return payment
      ? {
          institution: payment.institutionId,
          currency: payment.amount.currency,
          amount: minorToDecimalString(payment.amount.amountMinor, payment.amount.currency),
          reference: payment.reference,
        }
      : null;
  });

  protected readonly canReplay = computed(
    () => this.session.demoControls() && this.payment()?.provider === 'mock',
  );
  /** Only the fake bank's accounts react to a payment, and only if the customer has connected that bank. */
  protected readonly showsInAccounts = computed(() => {
    const payment = this.payment();
    return (
      payment?.provider === 'mock' &&
      ['executed', 'settled'].includes(payment.status) &&
      this.accounts.connections
        .value()
        .some((connection) => connection.institutionId === payment.institutionId)
    );
  });

  protected readonly checking = signal(false);
  protected readonly replaying = signal(false);

  constructor() {
    this.events.connect();
    this.events.stream.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event.type === 'payment.updated' && event.payment.id === this.id()) {
        this.resource.value.set(event.payment);
      }
    });

    const timer = setInterval(() => {
      if (!this.events.connected() && !this.finished()) this.resource.reload();
    }, FALLBACK_REFRESH_MS);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(timer);
    });
  }

  protected async check(): Promise<void> {
    this.checking.set(true);
    try {
      this.resource.value.set(await this.data.check(this.id()));
    } catch (error) {
      this.snackBar.open(toApiError(error).message, 'OK');
    } finally {
      this.checking.set(false);
    }
  }

  protected async replay(): Promise<void> {
    this.replaying.set(true);
    try {
      const message = await this.data.replayLastWebhook(this.id());
      this.snackBar.open(message, 'OK', { duration: 9000 });
      this.resource.reload();
    } catch (error) {
      this.snackBar.open(toApiError(error).message, 'OK');
    } finally {
      this.replaying.set(false);
    }
  }
}
