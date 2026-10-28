import type { Money } from './common';

const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'UGX', 'XAF', 'XOF']);
const THREE_DECIMAL = new Set(['BHD', 'KWD', 'OMR', 'JOD', 'TND']);

/** Number of minor-unit digits for an ISO 4217 currency (2 unless known otherwise). */
export function currencyExponent(currency: string): number {
  if (ZERO_DECIMAL.has(currency)) return 0;
  if (THREE_DECIMAL.has(currency)) return 3;
  return 2;
}

/**
 * Parses a user-typed decimal amount ("12.50", "12,5", "1 234.00") into integer minor units.
 * Returns null for anything that is not a positive amount with at most the currency's decimals.
 */
export function toMinorUnits(input: string, currency: string): number | null {
  const exponent = currencyExponent(currency);
  const cleaned = input
    .trim()
    .replace(/[\s_']/g, '')
    .replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const [whole = '0', fraction = ''] = cleaned.split('.');
  if (fraction.length > exponent) return null;
  const minor = Number(whole) * 10 ** exponent + Number(fraction.padEnd(exponent, '0') || '0');
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

/** Plain decimal string for an amount, e.g. (1250, EUR) -> "12.50". Used for provider payloads and CSV. */
export function minorToDecimalString(amountMinor: number, currency: string): string {
  const exponent = currencyExponent(currency);
  const negative = amountMinor < 0;
  const digits = String(Math.abs(amountMinor)).padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent > 0 ? `.${digits.slice(digits.length - exponent)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new Error(`Cannot add ${a.currency} to ${b.currency}`);
  }
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

/** Totals per currency. Amounts in different currencies are never combined. */
export function sumByCurrency(items: readonly Money[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const item of items) {
    totals.set(item.currency, (totals.get(item.currency) ?? 0) + item.amountMinor);
  }
  return totals;
}
