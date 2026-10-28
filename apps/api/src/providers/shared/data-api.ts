import { createHash } from 'node:crypto';
import {
  currencyExponent,
  maskAccountNumber,
  maskIdentifier,
  type AccountType,
} from '@ledger-lens/contracts';
import * as z from 'zod';
import { AppError } from '../../errors';
import type { Permission } from '@ledger-lens/contracts';
import {
  ConsentGoneError,
  InvalidGrantError,
  TokenRejectedError,
  type ProviderAccount,
  type ProviderBalance,
  type ProviderTransaction,
} from '../port';
import type { HttpResult } from '../transport';

/**
 * DTOs and mappers for the "Data API" dialect: `results[]` envelopes, decimal JSON numbers, ISO timestamps, account
 * numbers split into iban / number / sort code. TrueLayer speaks it, and the mock bank deliberately mimics it, so this
 * mapping layer is covered by offline tests either way. Provider-specific differences live in each adapter.
 */

export const OAuthTokenDto = z.object({
  access_token: z.string(),
  refresh_token: z.string().nullish(),
  expires_in: z.number().int().positive(),
  scope: z.string().nullish(),
});

export const AccountsDto = z.object({
  results: z.array(
    z.object({
      account_id: z.string(),
      account_type: z.string(),
      display_name: z.string(),
      currency: z.string().length(3),
      account_number: z
        .object({
          iban: z.string().nullish(),
          number: z.string().nullish(),
          sort_code: z.string().nullish(),
          swift_bic: z.string().nullish(),
        })
        .optional(),
      update_timestamp: z.string().optional(),
    }),
  ),
});

export const BalanceDto = z.object({
  results: z
    .array(
      z.object({
        currency: z.string().length(3),
        available: z.number().nullish(),
        current: z.number(),
        update_timestamp: z.string(),
      }),
    )
    .min(1),
});

const TransactionDto = z.object({
  transaction_id: z.string().nullish(),
  normalised_provider_transaction_id: z.string().nullish(),
  timestamp: z.string(),
  description: z.string(),
  amount: z.number(),
  currency: z.string().length(3),
  transaction_type: z.string().nullish(),
  transaction_category: z.string().nullish(),
  merchant_name: z.string().nullish(),
});

export const TransactionsDto = z.object({
  results: z.array(TransactionDto),
  next_cursor: z.string().nullish(),
});

export const MeDto = z.object({
  results: z
    .array(
      z.object({
        consent_expires_at: z.string().nullish(),
        scopes: z.array(z.string()).optional(),
      }),
    )
    .min(1),
});

export type TransactionDtoType = z.infer<typeof TransactionDto>;

/** Consent end and granted permissions from the `/me` response. */
export function mapConsent(dto: z.infer<typeof MeDto>): {
  expiresAt: string | null;
  permissions: Permission[];
} {
  const me = dto.results[0];
  const scopes = new Set(me?.scopes ?? []);
  return {
    expiresAt: me?.consent_expires_at ? normaliseTimestamp(me.consent_expires_at) : null,
    permissions: (['accounts', 'balances', 'transactions'] as const).filter((permission) =>
      scopes.has(permission === 'balances' ? 'balance' : permission),
    ),
  };
}

/** Parses a provider body or reports provider drift as a 502 instead of crashing downstream. */
export function parseDto<T extends z.ZodType>(schema: T, body: unknown, what: string): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AppError('provider_error', 502, `The bank returned an unexpected ${what} response.`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/**
 * JSON decimals arrive as binary floats (19.99 * 100 = 1998.9999999999998), so round to the currency's exponent
 * instead of truncating.
 */
export function decimalToMinor(value: number, currency: string): number {
  return Math.round(value * 10 ** currencyExponent(currency));
}

/** Providers send local-looking timestamps without an offset (`2026-10-27T00:00:00`); read those as UTC, not server time. */
const WITHOUT_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

export function normaliseTimestamp(value: string): string {
  const time = new Date(WITHOUT_ZONE.test(value) ? `${value}Z` : value);
  if (Number.isNaN(time.getTime())) {
    throw new AppError('provider_error', 502, 'The bank returned an invalid timestamp.');
  }
  return time.toISOString();
}

export function mapAccountType(type: string): AccountType {
  switch (type.toUpperCase()) {
    case 'TRANSACTION':
    case 'CURRENT':
      return 'current';
    case 'SAVINGS':
      return 'savings';
    case 'CREDIT_CARD':
    case 'CARD':
      return 'credit_card';
    default:
      return 'other';
  }
}

export function maskedAccountIdentifier(
  number:
    | {
        iban?: string | null | undefined;
        number?: string | null | undefined;
        sort_code?: string | null | undefined;
      }
    | undefined,
): string | null {
  if (!number) return null;
  if (number.iban) return maskIdentifier(number.iban);
  if (number.number) {
    return number.sort_code
      ? `${number.sort_code} ${maskAccountNumber(number.number)}`
      : maskAccountNumber(number.number);
  }
  return null;
}

export function mapBalance(dto: z.infer<typeof BalanceDto>): ProviderBalance {
  const row = dto.results[0];
  return {
    balance: { amountMinor: decimalToMinor(row.current, row.currency), currency: row.currency },
    availableBalance:
      row.available === null || row.available === undefined
        ? null
        : { amountMinor: decimalToMinor(row.available, row.currency), currency: row.currency },
    at: normaliseTimestamp(row.update_timestamp),
  };
}

export function mapAccounts(
  dto: z.infer<typeof AccountsDto>,
): Omit<ProviderAccount, keyof ProviderBalance>[] {
  return dto.results.map((account) => ({
    providerAccountId: account.account_id,
    name: account.display_name,
    type: mapAccountType(account.account_type),
    currency: account.currency,
    maskedIdentifier: maskedAccountIdentifier(account.account_number),
  }));
}

/** The sign comes from the transaction type when there is one, so providers that send magnitudes still land right. */
function signedAmountMinor(row: TransactionDtoType): number {
  const minor = decimalToMinor(row.amount, row.currency);
  switch (row.transaction_type?.toUpperCase()) {
    case 'DEBIT':
      return -Math.abs(minor);
    case 'CREDIT':
      return Math.abs(minor);
    default:
      return minor;
  }
}

/**
 * Pending rows carry no id and booked rows sometimes lack one too, so derive a deterministic one. Two identical
 * rows on the same day (two coffees) get an occurrence suffix instead of colliding.
 */
export function mapTransactions(
  rows: readonly TransactionDtoType[],
  status: 'pending' | 'booked',
  accountId: string,
): ProviderTransaction[] {
  const occurrences = new Map<string, number>();
  return rows.map((row) => {
    const bookedAt = normaliseTimestamp(row.timestamp);
    const amountMinor = signedAmountMinor(row);
    const stableId = row.transaction_id ?? row.normalised_provider_transaction_id ?? null;
    let providerTxnId: string;
    if (stableId) {
      providerTxnId = stableId;
    } else {
      const digest = createHash('sha256')
        .update(`${accountId}|${status}|${bookedAt.slice(0, 10)}|${amountMinor}|${row.description}`)
        .digest('hex')
        .slice(0, 20);
      const n = (occurrences.get(digest) ?? 0) + 1;
      occurrences.set(digest, n);
      providerTxnId = `${status === 'pending' ? 'p' : 'd'}_${digest}-${n}`;
    }
    return {
      providerTxnId,
      bookedAt,
      status,
      amount: { amountMinor, currency: row.currency },
      description: row.description.trim(),
      counterparty: row.merchant_name?.trim() || null,
      providerCategory: row.transaction_category ?? null,
    };
  });
}

/** OAuth token endpoint failures: `invalid_grant` means the code or refresh token is dead; the rest is the bank's problem or ours. */
export function throwTokenError(response: HttpResult): never {
  const error = (response.body as { error?: string } | undefined)?.error;
  if (response.status === 400 && error === 'invalid_grant') {
    throw new InvalidGrantError('The grant is no longer valid');
  }
  if (response.status >= 500) {
    throw new AppError('bank_unavailable', 503, 'The bank is temporarily unavailable.');
  }
  throw new AppError('provider_error', 502, 'The bank refused the token request.');
}

/** Turns a failed Data API response into the error the core knows how to handle. */
export function throwDataApiError(response: HttpResult): never {
  const body = (response.body ?? {}) as { error?: string; error_description?: string };
  const description = `${body.error ?? ''} ${body.error_description ?? ''}`.toLowerCase();
  if (response.status === 401) throw new TokenRejectedError('Access token rejected');
  // The 90-day strong-authentication window is over: only signing in at the bank again helps, so do not retry.
  if (body.error === 'sca_exceeded')
    throw new InvalidGrantError('Strong authentication has expired');
  if (response.status === 403) {
    throw new ConsentGoneError(description.includes('revok') ? 'revoked' : 'expired');
  }
  if (response.status === 429) {
    const retry = Number(response.headers['retry-after']);
    throw new AppError('rate_limited', 429, 'The bank is limiting requests. Try again shortly.', {
      ...(Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: Math.ceil(retry) } : {}),
    });
  }
  if (response.status >= 500) {
    throw new AppError('bank_unavailable', 503, 'The bank is temporarily unavailable.');
  }
  throw new AppError(
    'provider_error',
    502,
    `The bank responded with an unexpected status (${response.status}).`,
  );
}
