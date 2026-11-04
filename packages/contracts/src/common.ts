/**
 * Amounts are integer minor units plus an ISO 4217 code. Never floats; amounts in different currencies are only added after
 * an explicit conversion (the Home screen converts to UAH with monobank's own rates). Negative is money leaving.
 */
export interface Money {
  amountMinor: number;
  currency: string;
}

/**
 * Where a connection's data comes from. `monobank` and `privatbank` read the customer's own accounts with a token they issued
 * at the bank; `demo` is the monobank adapter against an in-process fake; `privat24` is a statement file the person imported
 * (nothing is called, so there is no token and no live sync).
 */
export type ProviderId = 'monobank' | 'demo' | 'privatbank' | 'privat24' | 'wise';

/** The bank an account belongs to, as the screens name it. The demo is a made-up monobank. */
export type BankId = 'monobank' | 'privatbank' | 'wise';

/** `demo` is the in-process fake, `live` is the real bank. */
export type ProviderMode = 'demo' | 'live';

export const PROVIDER_IDS: readonly ProviderId[] = [
  'monobank',
  'demo',
  'privatbank',
  'privat24',
  'wise',
];

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
export const PROBLEM_TYPE_BASE = 'https://ledger-lens.dev/problems/';
