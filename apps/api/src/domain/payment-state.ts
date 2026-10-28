import type {
  PaymentFailureReason,
  PaymentHistoryEntry,
  PaymentStatus,
} from '@ledger-lens/contracts';

/** Forward progress of a payment that is still on its way; failure and cancellation are handled separately. */
const PROGRESS: Partial<Record<PaymentStatus, number>> = {
  pending: 0,
  authorised: 1,
  executed: 2,
  settled: 3,
};

export interface PaymentState {
  status: PaymentStatus;
  failureReason: PaymentFailureReason | null;
  settlementExpected: boolean;
  statusHistory: PaymentHistoryEntry[];
}

export interface PaymentUpdate {
  status: PaymentStatus;
  failureReason: PaymentFailureReason | null;
  /** When the provider says it happened; falls back to when we heard about it. */
  at: string;
  note: string | null;
}

/** Nothing more will happen to the payment, so there is nothing left to wait for or poll. */
export function isFinal(state: Pick<PaymentState, 'status' | 'settlementExpected'>): boolean {
  switch (state.status) {
    case 'settled':
    case 'failed':
    case 'cancelled':
      return true;
    case 'executed':
      return !state.settlementExpected;
    default:
      return false;
  }
}

export interface Transition {
  changed: boolean;
  state: PaymentState;
}

/**
 * Applies a status report from a webhook or a poll. Providers deliver events at least once and not always in order, so
 * the rules are what make replays and stragglers harmless:
 *
 *  - a payment that is final never changes;
 *  - progress only moves forward (a late "authorised" cannot undo "executed");
 *  - failing or cancelling is allowed from any state that is not final;
 *  - reporting the status we already hold is a no-op, so duplicates leave no trace.
 */
export function applyUpdate(state: PaymentState, update: PaymentUpdate): Transition {
  const unchanged: Transition = { changed: false, state };
  if (isFinal(state)) {
    // The one exception: a payment that was final at "executed" may still be reported settled; that is progress.
    const lateSettlement =
      state.status === 'executed' && update.status === 'settled' && !state.settlementExpected;
    if (!lateSettlement) return unchanged;
  }
  if (update.status === state.status) return unchanged;

  const isFailure = update.status === 'failed' || update.status === 'cancelled';
  if (!isFailure) {
    const from = PROGRESS[state.status];
    const to = PROGRESS[update.status];
    if (from === undefined || to === undefined || to <= from) return unchanged;
  }

  return {
    changed: true,
    state: {
      ...state,
      status: update.status,
      failureReason: isFailure ? (update.failureReason ?? 'provider_error') : null,
      statusHistory: [
        ...state.statusHistory,
        { status: update.status, at: update.at, note: update.note },
      ],
    },
  };
}
