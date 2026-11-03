import { currencyExponent } from '@ledger-lens/contracts';
import type { RatePair } from '../providers/port';

/**
 * monobank's published rates, enough to value a balance in hryvnias. For a currency we want what the bank would pay for it
 * (`rateBuy`), then its cross rate, then the sell rate. Rates are decimals by nature; the converted amount is rounded to an
 * integer minor unit straight away.
 */
export class RateTable {
  constructor(readonly pairs: readonly RatePair[]) {}

  /** Hryvnias for one unit of `currency`, or null when monobank publishes no direct rate. */
  perUnit(currency: string): number | null {
    if (currency === 'UAH') return 1;
    const pair = this.pairs.find((p) => p.a === currency && p.b === 'UAH');
    if (!pair) return null;
    return pair.buy ?? pair.cross ?? pair.sell ?? null;
  }

  toUahMinor(amountMinor: number, currency: string): number | null {
    if (currency === 'UAH') return amountMinor;
    const rate = this.perUnit(currency);
    if (rate === null) return null;
    return Math.round((amountMinor / 10 ** currencyExponent(currency)) * rate * 100);
  }

  /** When monobank last updated any of the pairs to hryvnias, as an ISO time, or null for an empty table. */
  asOf(): string | null {
    let latest = 0;
    for (const pair of this.pairs) if (pair.b === 'UAH' && pair.date > latest) latest = pair.date;
    return latest > 0 ? new Date(latest * 1000).toISOString() : null;
  }

  isEmpty(): boolean {
    return this.pairs.length === 0;
  }
}
