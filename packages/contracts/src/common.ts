import * as z from 'zod';

/** ISO 8601 timestamp in UTC, e.g. 2026-10-28T10:15:00.000Z. */
export const IsoDateTime = z.iso.datetime({ offset: true });

/** Calendar date, e.g. 2026-10-28. */
export const IsoDate = z.iso.date();

/** ISO 4217 alphabetic currency code. */
export const Currency = z.string().regex(/^[A-Z]{3}$/, 'Expected an ISO 4217 code such as EUR');
export type Currency = z.infer<typeof Currency>;

/**
 * Amounts are integer minor units plus a currency. Never floats, and amounts in different
 * currencies are never added together. Negative values are money leaving the account.
 */
export const Money = z.object({
  amountMinor: z.number().int().safe(),
  currency: Currency,
});
export type Money = z.infer<typeof Money>;

/** Provider adapters that can sit behind the BankingProvider port. */
export const ProviderId = z.enum(['mock', 'truelayer', 'enablebanking', 'monobank']);
export type ProviderId = z.infer<typeof ProviderId>;

/** `mock` is the in-process fake bank, `sandbox` is a provider test environment, `live` is real banks. */
export const ProviderMode = z.enum(['mock', 'sandbox', 'live']);
export type ProviderMode = z.infer<typeof ProviderMode>;

/** Opaque server-issued id such as `con_8f3k2n1x`. */
export const Id = z.string().min(1).max(64);
