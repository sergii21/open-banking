/**
 * Decimal text to integer minor units, with integer arithmetic only: `"1 234,50"` and `"1234.5"` both become 123450 for a
 * currency with two decimals. Banks and spreadsheets write amounts as text, and a float in between would turn 0.1 + 0.2 into
 * a lie. Returns null for anything that is not a plain number (a currency symbol, a date, an empty cell), so the caller
 * decides whether that row can be used. Digits beyond the currency's precision are rounded half away from zero.
 */
export function decimalToMinor(text: string, exponent: number): number | null {
  const cleaned = text
    .trim()
    .replace(/[\s\u00a0\u202f]/g, '')
    .replace(/^[−–]/, '-')
    .replace(',', '.');
  const match = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (!match) return null;
  const fraction = match[3] ?? '';
  const kept = exponent > 0 ? fraction.slice(0, exponent).padEnd(exponent, '0') : '';
  const roundUp = fraction.length > exponent && (fraction.charCodeAt(exponent) || 48) >= 53 ? 1 : 0;
  const minor = Number(match[2]) * 10 ** exponent + (kept ? Number(kept) : 0) + roundUp;
  if (!Number.isSafeInteger(minor)) return null;
  return match[1] === '-' ? -minor : minor;
}
