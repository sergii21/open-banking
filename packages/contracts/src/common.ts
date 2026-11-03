/**
 * Amounts are integer minor units plus an ISO 4217 code. Never floats; amounts in different currencies are only added after
 * an explicit conversion (the Home screen converts to UAH with monobank's own rates). Negative is money leaving.
 */
export interface Money {
  amountMinor: number;
  currency: string;
}

/** `monobank` reads the customer's own accounts with their token; `demo` is the same adapter against an in-process fake. */
export type ProviderId = 'monobank' | 'demo';

/** `demo` is the in-process fake, `live` is the real bank. */
export type ProviderMode = 'demo' | 'live';

export const PROVIDER_IDS: readonly ProviderId[] = ['monobank', 'demo'];

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
export const PROBLEM_TYPE_BASE = 'https://ledger-lens.dev/problems/';
