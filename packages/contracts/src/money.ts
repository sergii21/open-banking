const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'UGX', 'XAF', 'XOF']);
const THREE_DECIMAL = new Set(['BHD', 'KWD', 'OMR', 'JOD', 'TND']);

/** Number of minor-unit digits for an ISO 4217 currency (2 unless known otherwise). */
export function currencyExponent(currency: string): number {
  if (ZERO_DECIMAL.has(currency)) return 0;
  if (THREE_DECIMAL.has(currency)) return 3;
  return 2;
}

/** Plain decimal string for an amount, e.g. (1250, UAH) -> "12.50". Used for CSV and diagnostics-free exports. */
export function minorToDecimalString(amountMinor: number, currency: string): string {
  const exponent = currencyExponent(currency);
  const digits = String(Math.abs(amountMinor)).padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent > 0 ? `.${digits.slice(digits.length - exponent)}` : '';
  return `${amountMinor < 0 ? '-' : ''}${whole}${fraction}`;
}

const SYMBOLS: Readonly<Record<string, string>> = {
  UAH: '₴',
  USD: '$',
  EUR: '€',
  GBP: '£',
  PLN: 'zł',
  CZK: 'Kč',
};

/** A non-breaking space keeps "12 345,67 ₴" on one line and digit groups together. */
export const NBSP = ' ';
const MINUS = '−';

export interface MoneyParts {
  negative: boolean;
  /** Digits grouped by thousands with non-breaking spaces. */
  whole: string;
  /** Minor digits, empty for currencies without any. */
  fraction: string;
  symbol: string;
}

function groupThousands(digits: string): string {
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += NBSP;
    out += digits[i];
  }
  return out;
}

/**
 * The pieces of an amount the way a Ukrainian reader expects them: "12 345,67 ₴". The screens render `whole` large and
 * `fraction` small and muted, so the parts are separate. Integer arithmetic only.
 */
export function moneyParts(amountMinor: number, currency: string, withFraction = true): MoneyParts {
  const exponent = currencyExponent(currency);
  const factor = 10 ** exponent;
  const abs = Math.abs(amountMinor);
  const symbol = SYMBOLS[currency] ?? currency;
  if (!withFraction || exponent === 0) {
    const whole = Math.round(abs / factor);
    return {
      negative: amountMinor < 0 && whole !== 0,
      whole: groupThousands(String(whole)),
      fraction: '',
      symbol,
    };
  }
  return {
    negative: amountMinor < 0,
    whole: groupThousands(String(Math.floor(abs / factor))),
    fraction: String(abs % factor).padStart(exponent, '0'),
    symbol,
  };
}

export interface FormatOptions {
  /** `always` puts a plus on income; `never` drops the sign; the default shows a minus only. */
  sign?: 'auto' | 'always' | 'never';
  fraction?: boolean;
}

export function formatMoney(
  amountMinor: number,
  currency: string,
  options: FormatOptions = {},
): string {
  const parts = moneyParts(amountMinor, currency, options.fraction ?? true);
  const sign =
    options.sign === 'never'
      ? ''
      : parts.negative
        ? MINUS
        : options.sign === 'always' && amountMinor > 0
          ? '+'
          : '';
  const number = parts.fraction ? `${parts.whole},${parts.fraction}` : parts.whole;
  return `${sign}${number}${NBSP}${parts.symbol}`;
}
