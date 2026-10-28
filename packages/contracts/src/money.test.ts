import { describe, expect, it } from 'vitest';
import {
  addMoney,
  currencyExponent,
  minorToDecimalString,
  sumByCurrency,
  toMinorUnits,
} from './money';

describe('currencyExponent', () => {
  it('knows zero and three decimal currencies and defaults to two', () => {
    expect(currencyExponent('EUR')).toBe(2);
    expect(currencyExponent('GBP')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
  });
});

describe('toMinorUnits', () => {
  it.each([
    ['12.50', 'EUR', 1250],
    ['12,5', 'EUR', 1250],
    ['0.01', 'EUR', 1],
    ['1 234.00', 'GBP', 123400],
    ['500', 'JPY', 500],
    ['1.250', 'KWD', 1250],
  ])('parses %s %s as %i minor units', (input, currency, expected) => {
    expect(toMinorUnits(input, currency)).toBe(expected);
  });

  it.each([
    ['', 'EUR'],
    ['abc', 'EUR'],
    ['-5', 'EUR'],
    ['0', 'EUR'],
    ['0.00', 'EUR'],
    ['1.234', 'EUR'],
    ['1.5', 'JPY'],
    ['1e3', 'EUR'],
  ])('rejects %j for %s', (input, currency) => {
    expect(toMinorUnits(input, currency)).toBeNull();
  });

  it('never goes through floating point for typical decimal fractions', () => {
    // 0.1 + 0.2 style traps: 19.99 * 100 is 1998.9999999999998 in IEEE 754.
    expect(toMinorUnits('19.99', 'EUR')).toBe(1999);
    expect(toMinorUnits('1.15', 'EUR')).toBe(115);
  });
});

describe('minorToDecimalString', () => {
  it('formats with the currency exponent and sign', () => {
    expect(minorToDecimalString(1250, 'EUR')).toBe('12.50');
    expect(minorToDecimalString(5, 'EUR')).toBe('0.05');
    expect(minorToDecimalString(-1999, 'GBP')).toBe('-19.99');
    expect(minorToDecimalString(500, 'JPY')).toBe('500');
    expect(minorToDecimalString(1250, 'KWD')).toBe('1.250');
  });
});

describe('money arithmetic', () => {
  it('adds same-currency amounts and refuses to mix currencies', () => {
    expect(
      addMoney({ amountMinor: 100, currency: 'EUR' }, { amountMinor: 250, currency: 'EUR' }),
    ).toEqual({ amountMinor: 350, currency: 'EUR' });
    expect(() =>
      addMoney({ amountMinor: 100, currency: 'EUR' }, { amountMinor: 250, currency: 'GBP' }),
    ).toThrow(/Cannot add/);
  });

  it('totals per currency without combining them', () => {
    const totals = sumByCurrency([
      { amountMinor: 100, currency: 'EUR' },
      { amountMinor: -30, currency: 'EUR' },
      { amountMinor: 999, currency: 'GBP' },
    ]);
    expect(Object.fromEntries(totals)).toEqual({ EUR: 70, GBP: 999 });
  });
});
