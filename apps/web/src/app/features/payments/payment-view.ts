import type { Payment, PaymentFailureReason, PaymentStatus } from '@ledger-lens/contracts';
import type { Tone } from '../../shared/status-chip/status-chip';

export interface StatusView {
  label: string;
  tone: Tone;
  icon: string;
}

/** The pill shown next to a payment. Text and icon always carry the meaning; the tone only reinforces it. */
export function statusView(payment: Pick<Payment, 'status'>): StatusView {
  switch (payment.status) {
    case 'pending':
      return { label: 'Waiting for approval', tone: 'warning', icon: 'hourglass_top' };
    case 'authorised':
      return { label: 'Authorised', tone: 'info', icon: 'verified_user' };
    case 'executed':
      return { label: 'Executed', tone: 'success', icon: 'send' };
    case 'settled':
      return { label: 'Settled', tone: 'success', icon: 'check_circle' };
    case 'failed':
      return { label: 'Failed', tone: 'error', icon: 'error' };
    case 'cancelled':
      return { label: 'Cancelled', tone: 'neutral', icon: 'cancel' };
  }
}

export interface FailureCopy {
  title: string;
  message: string;
  icon: string;
}

/** What went wrong in words a customer can act on. Every reason says whether money moved: it never did. */
export function failureCopy(reason: PaymentFailureReason | null): FailureCopy {
  switch (reason) {
    case 'authorisation_failed':
      return {
        title: 'Approval at your bank didn’t go through',
        message:
          'The bank couldn’t confirm it was you, so it never released the payment. No money moved. You can start again.',
        icon: 'lock_clock',
      };
    case 'execution_rejected':
      return {
        title: 'The bank rejected the payment',
        message:
          'You approved it, but the bank refused to carry it out. No money moved. Check the details or try a smaller amount.',
        icon: 'block',
      };
    case 'insufficient_funds':
      return {
        title: 'Not enough money in the account',
        message:
          'The bank declined the payment because the balance is too low. No money moved. Try a smaller amount.',
        icon: 'account_balance_wallet',
      };
    case 'cancelled':
      return {
        title: 'You cancelled at the bank',
        message: 'Nothing was paid. You can start again whenever you like.',
        icon: 'cancel',
      };
    case 'expired':
      return {
        title: 'The approval link expired',
        message:
          'The payment wasn’t approved in time. The bank’s link only works for about 15 minutes. Nothing was paid.',
        icon: 'timer_off',
      };
    case 'provider_error':
    case null:
      return {
        title: 'The bank had a problem',
        message:
          'Something went wrong on the bank’s side before the payment completed. Nothing was paid. Try again in a few minutes.',
        icon: 'cloud_off',
      };
  }
}

export type StepState = 'done' | 'current' | 'upcoming' | 'failed';

export interface TimelineStep {
  status: Extract<PaymentStatus, 'pending' | 'authorised' | 'executed' | 'settled'>;
  label: string;
  hint: string;
  state: StepState;
  /** When the payment reached this step, if we were told. */
  at: string | null;
}

const PROGRESS = ['pending', 'authorised', 'executed', 'settled'] as const;

const STEP_COPY: Record<(typeof PROGRESS)[number], { label: string; hint: string }> = {
  pending: { label: 'Pending', hint: 'Created. Waiting for you to approve it at your bank.' },
  authorised: { label: 'Authorised', hint: 'You approved it at your bank.' },
  executed: { label: 'Executed', hint: 'The bank has sent the money.' },
  settled: { label: 'Settled', hint: 'The money has arrived in the payee’s account.' },
};

/**
 * Pending, Authorised, Executed and (where the payee settles) Settled, with where this payment is. A payment that
 * failed stops at the last step it reached, and the step it never got to is the one marked failed.
 */
export function buildTimeline(
  payment: Pick<Payment, 'status' | 'statusHistory' | 'settlementExpected'>,
): TimelineStep[] {
  const steps = PROGRESS.filter((step) => step !== 'settled' || payment.settlementExpected);
  const at = (status: string): string | null =>
    [...payment.statusHistory].reverse().find((entry) => entry.status === status)?.at ?? null;
  const index = (status: string): number => steps.findIndex((step) => step === status);

  const failed = payment.status === 'failed' || payment.status === 'cancelled';
  if (failed) {
    const reached = Math.max(0, ...payment.statusHistory.map((entry) => index(entry.status)));
    return steps.map((status, i) => ({
      status,
      ...STEP_COPY[status],
      at: i <= reached ? at(status) : null,
      state: i <= reached ? 'done' : i === reached + 1 ? 'failed' : 'upcoming',
    }));
  }

  // A bank that does not settle ends at "executed", which is then the finish, not a step in progress.
  const here = Math.max(0, index(payment.status));
  const finished = here === steps.length - 1;
  return steps.map((status, i) => ({
    status,
    ...STEP_COPY[status],
    at: i <= here ? at(status) : null,
    state: i < here || (i === here && finished) ? 'done' : i === here ? 'current' : 'upcoming',
  }));
}

export const isFinished = (payment: Pick<Payment, 'status' | 'settlementExpected'>): boolean =>
  payment.status === 'failed' ||
  payment.status === 'cancelled' ||
  payment.status === 'settled' ||
  (payment.status === 'executed' && !payment.settlementExpected);
