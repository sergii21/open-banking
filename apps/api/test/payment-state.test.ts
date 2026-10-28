import { describe, expect, it } from 'vitest';
import {
  applyUpdate,
  isFinal,
  type PaymentState,
  type PaymentUpdate,
} from '../src/domain/payment-state';

const start = (overrides: Partial<PaymentState> = {}): PaymentState => ({
  status: 'pending',
  failureReason: null,
  settlementExpected: true,
  statusHistory: [{ status: 'pending', at: '2026-10-28T10:00:00.000Z', note: null }],
  ...overrides,
});

const update = (
  status: PaymentUpdate['status'],
  extra: Partial<PaymentUpdate> = {},
): PaymentUpdate => ({
  status,
  failureReason: null,
  at: '2026-10-28T10:00:05.000Z',
  note: null,
  ...extra,
});

describe('payment state machine', () => {
  it('moves forward through the happy path and records each step', () => {
    let state = start();
    for (const status of ['authorised', 'executed', 'settled'] as const) {
      const next = applyUpdate(state, update(status));
      expect(next.changed).toBe(true);
      state = next.state;
    }
    expect(state.status).toBe('settled');
    expect(state.statusHistory.map((h) => h.status)).toEqual([
      'pending',
      'authorised',
      'executed',
      'settled',
    ]);
  });

  it('ignores a duplicate report of the status it already holds', () => {
    const state = start({ status: 'authorised' });
    expect(applyUpdate(state, update('authorised')).changed).toBe(false);
  });

  it('ignores a straggler that would move the payment backwards', () => {
    const state = start({ status: 'executed' });
    expect(applyUpdate(state, update('authorised')).changed).toBe(false);
    expect(applyUpdate(state, update('pending')).changed).toBe(false);
  });

  it('accepts a skipped step, because the provider may only tell us about the later one', () => {
    const next = applyUpdate(start(), update('executed'));
    expect(next.changed).toBe(true);
    expect(next.state.statusHistory.map((h) => h.status)).toEqual(['pending', 'executed']);
  });

  it('never changes once final', () => {
    const settled = start({ status: 'settled' });
    const failed = start({ status: 'failed', failureReason: 'execution_rejected' });
    expect(applyUpdate(settled, update('failed')).changed).toBe(false);
    expect(applyUpdate(failed, update('executed')).changed).toBe(false);
    expect(applyUpdate(failed, update('cancelled')).changed).toBe(false);
  });

  it('records a failure with its reason, defaulting to a provider error when none is given', () => {
    const rejected = applyUpdate(
      start({ status: 'authorised' }),
      update('failed', { failureReason: 'insufficient_funds' }),
    );
    expect(rejected.state).toMatchObject({ status: 'failed', failureReason: 'insufficient_funds' });
    const unknown = applyUpdate(start(), update('failed'));
    expect(unknown.state.failureReason).toBe('provider_error');
    const cancelled = applyUpdate(start(), update('cancelled', { failureReason: 'cancelled' }));
    expect(cancelled.state).toMatchObject({ status: 'cancelled', failureReason: 'cancelled' });
  });

  it('treats "executed" as final when no settlement is expected, yet still accepts a late settlement', () => {
    const open = start({ status: 'executed', settlementExpected: false });
    expect(isFinal(open)).toBe(true);
    expect(isFinal(start({ status: 'executed' }))).toBe(false);
    expect(applyUpdate(open, update('failed')).changed).toBe(false);
    expect(applyUpdate(open, update('settled')).changed).toBe(true);
  });
});
