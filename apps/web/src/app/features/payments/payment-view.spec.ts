import type { Payment, PaymentStatus } from '@ledger-lens/contracts';
import { buildTimeline, failureCopy, isFinished, statusView } from './payment-view';

type Shape = Pick<Payment, 'status' | 'statusHistory' | 'settlementExpected'>;

const history = (...statuses: PaymentStatus[]): Payment['statusHistory'] =>
  statuses.map((status, i) => ({
    status,
    at: `2026-10-28T10:00:0${i}.000Z`,
    note: null,
  }));

const states = (payment: Shape): string[] => buildTimeline(payment).map((s) => s.state);

describe('payment timeline', () => {
  it('shows a new payment as waiting at the first step', () => {
    expect(
      states({ status: 'pending', statusHistory: history('pending'), settlementExpected: true }),
    ).toEqual(['current', 'upcoming', 'upcoming', 'upcoming']);
  });

  it('moves the marker along as the bank reports progress', () => {
    const base = { settlementExpected: true };
    expect(
      states({ ...base, status: 'authorised', statusHistory: history('pending', 'authorised') }),
    ).toEqual(['done', 'current', 'upcoming', 'upcoming']);
    expect(
      states({
        ...base,
        status: 'executed',
        statusHistory: history('pending', 'authorised', 'executed'),
      }),
    ).toEqual(['done', 'done', 'current', 'upcoming']);
    expect(
      states({
        ...base,
        status: 'settled',
        statusHistory: history('pending', 'authorised', 'executed', 'settled'),
      }),
    ).toEqual(['done', 'done', 'done', 'done']);
  });

  it('leaves out Settled when the payee never settles, and treats Executed as the finish', () => {
    const payment: Shape = {
      status: 'executed',
      statusHistory: history('pending', 'authorised', 'executed'),
      settlementExpected: false,
    };
    const steps = buildTimeline(payment);
    expect(steps.map((s) => s.label)).toEqual(['Pending', 'Authorised', 'Executed']);
    expect(steps.map((s) => s.state)).toEqual(['done', 'done', 'done']);
    expect(isFinished(payment)).toBe(true);
  });

  it('marks the step a failed payment never reached, and keeps the ones before it', () => {
    expect(
      states({
        status: 'failed',
        statusHistory: history('pending', 'failed'),
        settlementExpected: true,
      }),
    ).toEqual(['done', 'failed', 'upcoming', 'upcoming']);
    expect(
      states({
        status: 'failed',
        statusHistory: history('pending', 'authorised', 'failed'),
        settlementExpected: true,
      }),
    ).toEqual(['done', 'done', 'failed', 'upcoming']);
    expect(
      states({
        status: 'cancelled',
        statusHistory: history('pending', 'cancelled'),
        settlementExpected: false,
      }),
    ).toEqual(['done', 'failed', 'upcoming']);
  });

  it('carries the time each step was reached, and none for steps that were not', () => {
    const steps = buildTimeline({
      status: 'authorised',
      statusHistory: history('pending', 'authorised'),
      settlementExpected: true,
    });
    expect(steps.map((s) => s.at)).toEqual([
      '2026-10-28T10:00:00.000Z',
      '2026-10-28T10:00:01.000Z',
      null,
      null,
    ]);
  });

  it('counts a skipped step as reached when a later one was reported (a missed webhook)', () => {
    expect(
      states({
        status: 'settled',
        statusHistory: history('pending', 'settled'),
        settlementExpected: true,
      }),
    ).toEqual(['done', 'done', 'done', 'done']);
  });
});

describe('payment status and failure copy', () => {
  it('always gives a status text and icon, never colour alone', () => {
    const statuses: PaymentStatus[] = [
      'pending',
      'authorised',
      'executed',
      'settled',
      'failed',
      'cancelled',
    ];
    for (const status of statuses) {
      const view = statusView({ status });
      expect(view.label.length).toBeGreaterThan(0);
      expect(view.icon.length).toBeGreaterThan(0);
    }
  });

  it('tells the customer, for every failure, that nothing was paid', () => {
    for (const reason of [
      'authorisation_failed',
      'execution_rejected',
      'insufficient_funds',
      'cancelled',
      'expired',
      'provider_error',
      null,
    ] as const) {
      expect(failureCopy(reason).message.toLowerCase()).toMatch(/no money moved|nothing was paid/);
    }
  });

  it('knows when a payment has nothing left to wait for', () => {
    const open: Shape = { status: 'authorised', statusHistory: [], settlementExpected: true };
    expect(isFinished(open)).toBe(false);
    expect(isFinished({ ...open, status: 'executed' })).toBe(false);
    expect(isFinished({ ...open, status: 'executed', settlementExpected: false })).toBe(true);
    expect(isFinished({ ...open, status: 'failed' })).toBe(true);
  });
});
