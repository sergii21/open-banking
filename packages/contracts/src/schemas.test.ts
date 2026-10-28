import { describe, expect, it } from 'vitest';
import {
  CreatePaymentRequest,
  ErrorCode,
  MAX_PAYMENT_MINOR,
  Money,
  Problem,
  ServerEvent,
  TransactionQuery,
} from './index';

const validPayment = {
  institutionId: 'mock:mock-bank',
  amountMinor: 2500,
  currency: 'EUR',
  beneficiary: { type: 'iban', name: 'Alex Example', iban: 'DE89 3704 0044 0532 0130 00' },
  reference: 'Rent October',
};

describe('Money', () => {
  it('rejects fractional minor units and malformed currencies', () => {
    expect(Money.safeParse({ amountMinor: 10.5, currency: 'EUR' }).success).toBe(false);
    expect(Money.safeParse({ amountMinor: 10, currency: 'eur' }).success).toBe(false);
    expect(Money.safeParse({ amountMinor: -10, currency: 'EUR' }).success).toBe(true);
  });
});

describe('CreatePaymentRequest', () => {
  it('accepts a valid IBAN payment', () => {
    expect(CreatePaymentRequest.safeParse(validPayment).success).toBe(true);
  });

  it('rejects a bad IBAN checksum, an oversize amount and a long reference', () => {
    const badIban = CreatePaymentRequest.safeParse({
      ...validPayment,
      beneficiary: { ...validPayment.beneficiary, iban: 'DE89370400440532013001' },
    });
    expect(badIban.success).toBe(false);

    expect(
      CreatePaymentRequest.safeParse({ ...validPayment, amountMinor: MAX_PAYMENT_MINOR + 1 })
        .success,
    ).toBe(false);
    expect(
      CreatePaymentRequest.safeParse({ ...validPayment, reference: 'x'.repeat(19) }).success,
    ).toBe(false);
    expect(CreatePaymentRequest.safeParse({ ...validPayment, amountMinor: 0 }).success).toBe(false);
  });

  it('accepts UK sort code + account number payees', () => {
    const result = CreatePaymentRequest.safeParse({
      ...validPayment,
      currency: 'GBP',
      beneficiary: {
        type: 'sort_code_account_number',
        name: 'Sam Example',
        sortCode: '040004',
        accountNumber: '12345678',
      },
    });
    expect(result.success).toBe(true);
  });
});

describe('TransactionQuery', () => {
  it('coerces query-string numbers and applies the default page size', () => {
    const parsed = TransactionQuery.parse({ minAmountMinor: '500', category: 'groceries' });
    expect(parsed.minAmountMinor).toBe(500);
    expect(parsed.limit).toBe(50);
  });

  it('rejects an unknown category and an oversize page', () => {
    expect(TransactionQuery.safeParse({ category: 'gambling' }).success).toBe(false);
    expect(TransactionQuery.safeParse({ limit: '500' }).success).toBe(false);
  });
});

describe('Problem / events', () => {
  it('only allows documented error codes', () => {
    expect(ErrorCode.safeParse('consent_expired').success).toBe(true);
    expect(ErrorCode.safeParse('teapot').success).toBe(false);
    expect(
      Problem.safeParse({ type: 'x', title: 'Rate limited', status: 429, code: 'rate_limited' })
        .success,
    ).toBe(true);
  });

  it('discriminates server events on type', () => {
    expect(ServerEvent.safeParse({ type: 'nope' }).success).toBe(false);
  });
});
