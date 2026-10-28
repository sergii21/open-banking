import { describe, expect, it } from 'vitest';
import { AppError } from '../src/errors';
import { ConsentGoneError, TokenRejectedError } from '../src/providers/port';
import {
  AccountsDto,
  BalanceDto,
  TransactionsDto,
  decimalToMinor,
  mapAccountType,
  mapAccounts,
  mapBalance,
  mapTransactions,
  maskedAccountIdentifier,
  parseDto,
  throwDataApiError,
} from '../src/providers/shared/data-api';
import type { HttpResult } from '../src/providers/transport';

const response = (
  status: number,
  body: unknown = {},
  headers: Record<string, string> = {},
): HttpResult => ({
  status,
  ok: status < 400,
  headers,
  body,
  text: JSON.stringify(body),
});

describe('decimalToMinor', () => {
  it.each([
    [19.99, 'EUR', 1999],
    [0.1, 'EUR', 10],
    [-42.17, 'EUR', -4217],
    [1234567.89, 'GBP', 123456789],
    [0, 'EUR', 0],
    [500, 'JPY', 500],
    [1.005, 'KWD', 1005],
  ])('%s %s -> %i', (value, currency, expected) => {
    expect(decimalToMinor(value, currency)).toBe(expected);
  });

  it('survives the classic binary floating point traps', () => {
    expect(decimalToMinor(0.1 + 0.2, 'EUR')).toBe(30);
    expect(decimalToMinor(1.15, 'EUR')).toBe(115);
    expect(decimalToMinor(4.35, 'EUR')).toBe(435);
  });
});

describe('account mapping', () => {
  it('maps types and masks identifiers', () => {
    expect(mapAccountType('TRANSACTION')).toBe('current');
    expect(mapAccountType('savings')).toBe('savings');
    expect(mapAccountType('CREDIT_CARD')).toBe('credit_card');
    expect(mapAccountType('MORTGAGE')).toBe('other');
    expect(maskedAccountIdentifier({ iban: 'DE89370400440532013000' })).toBe('DE•• •••• •••• 3000');
    expect(maskedAccountIdentifier({ number: '12345678', sort_code: '04-00-04' })).toBe(
      '04-00-04 •••• 5678',
    );
    expect(maskedAccountIdentifier(undefined)).toBeNull();
  });

  it('never carries the full number into the normalised account', () => {
    const dto = parseDto(
      AccountsDto,
      {
        results: [
          {
            account_id: 'a1',
            account_type: 'TRANSACTION',
            display_name: 'Girokonto',
            currency: 'EUR',
            account_number: { iban: 'DE89370400440532013000', swift_bic: 'X' },
          },
        ],
      },
      'accounts',
    );
    const [account] = mapAccounts(dto);
    expect(JSON.stringify(account)).not.toContain('DE89370400440532013000');
    expect(account?.maskedIdentifier).toBe('DE•• •••• •••• 3000');
  });

  it('maps balances to minor units', () => {
    const balance = mapBalance(
      parseDto(
        BalanceDto,
        {
          results: [
            {
              currency: 'EUR',
              available: 2340.13,
              current: 2840.13,
              update_timestamp: '2026-10-28T10:00:00Z',
            },
          ],
        },
        'balance',
      ),
    );
    expect(balance).toEqual({
      balance: { amountMinor: 284_013, currency: 'EUR' },
      availableBalance: { amountMinor: 234_013, currency: 'EUR' },
      at: '2026-10-28T10:00:00.000Z',
    });
  });
});

describe('transaction mapping', () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    timestamp: '2026-10-27T09:10:00Z',
    description: '  REWE SAGT DANKE  ',
    amount: -42.17,
    currency: 'EUR',
    transaction_category: 'PURCHASE',
    merchant_name: 'REWE',
    ...overrides,
  });

  it('uses the provider id when there is one and trims text', () => {
    const [txn] = mapTransactions(
      [parseDto(TransactionsDto, { results: [row({ transaction_id: 'tx1' })] }, 'x').results[0]],
      'booked',
      'acc',
    );
    expect(txn).toMatchObject({
      providerTxnId: 'tx1',
      status: 'booked',
      amount: { amountMinor: -4217, currency: 'EUR' },
      description: 'REWE SAGT DANKE',
      counterparty: 'REWE',
      providerCategory: 'PURCHASE',
      bookedAt: '2026-10-27T09:10:00.000Z',
    });
  });

  it('derives stable ids for rows without one and keeps two identical coffees apart', () => {
    const rows = parseDto(
      TransactionsDto,
      { results: [row(), row(), row({ amount: -3.5 })] },
      'x',
    ).results;
    const first = mapTransactions(rows, 'pending', 'acc');
    const again = mapTransactions(rows, 'pending', 'acc');
    expect(first.map((t) => t.providerTxnId)).toEqual(again.map((t) => t.providerTxnId));
    expect(new Set(first.map((t) => t.providerTxnId)).size).toBe(3);
    expect(first[0]?.providerTxnId.startsWith('p_')).toBe(true);
    // A different account never collides with the same-looking row.
    expect(mapTransactions(rows, 'pending', 'other')[0]?.providerTxnId).not.toBe(
      first[0]?.providerTxnId,
    );
  });

  it('reports provider drift as a 502 instead of crashing later', () => {
    expect(() =>
      parseDto(TransactionsDto, { results: [{ amount: 'lots' }] }, 'transactions'),
    ).toThrow(AppError);
    try {
      parseDto(TransactionsDto, { nope: true }, 'transactions');
    } catch (error) {
      expect(error).toMatchObject({ code: 'provider_error', status: 502 });
    }
    expect(() => mapTransactions([{ ...row(), timestamp: 'not a date' }], 'booked', 'acc')).toThrow(
      /invalid timestamp/,
    );
  });
});

describe('throwDataApiError', () => {
  it('maps statuses to the errors the core understands', () => {
    expect(() => throwDataApiError(response(401, { error: 'invalid_token' }))).toThrow(
      TokenRejectedError,
    );
    expect(() =>
      throwDataApiError(
        response(403, { error: 'access_denied', error_description: 'consent_expired' }),
      ),
    ).toThrow(ConsentGoneError);
    try {
      throwDataApiError(response(403, { error_description: 'consent was revoked' }));
    } catch (error) {
      expect((error as ConsentGoneError).reason).toBe('revoked');
    }
    try {
      throwDataApiError(response(429, {}, { 'retry-after': '30' }));
    } catch (error) {
      expect(error).toMatchObject({ code: 'rate_limited', retryAfterSeconds: 30 });
    }
    try {
      throwDataApiError(response(503));
    } catch (error) {
      expect(error).toMatchObject({ code: 'bank_unavailable' });
    }
    try {
      throwDataApiError(response(418));
    } catch (error) {
      expect(error).toMatchObject({ code: 'provider_error' });
    }
  });
});
