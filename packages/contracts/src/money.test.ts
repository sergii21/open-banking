import { describe, expect, it } from 'vitest';
import {
  NBSP,
  currencyExponent,
  formatMoney,
  minorToDecimalString,
  moneyParts,
  parseAmountToMinor,
} from './money';

describe('parseAmountToMinor', () => {
  it('reads what a person types, with integer arithmetic', () => {
    expect(parseAmountToMinor('1 234,50', 'UAH')).toBe(123450);
    expect(parseAmountToMinor('1234.5', 'EUR')).toBe(123450);
    expect(parseAmountToMinor('19.99', 'EUR')).toBe(1999);
    expect(parseAmountToMinor('5', 'JPY')).toBe(5);
    expect(parseAmountToMinor('1.234', 'KWD')).toBe(1234);
  });
  it('refuses anything that is not a plain positive amount', () => {
    for (const typed of ['', '0', '0.00', '-5', 'abc', '1.234', '1,2,3', '1e5']) {
      expect(parseAmountToMinor(typed, 'EUR')).toBeNull();
    }
    expect(parseAmountToMinor('1.5', 'JPY')).toBeNull();
    expect(parseAmountToMinor('99999999999999999', 'EUR')).toBeNull();
  });
});

describe('currencyExponent', () => {
  it('knows zero and three decimal currencies and defaults to two', () => {
    expect(currencyExponent('UAH')).toBe(2);
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
  });
});

describe('minorToDecimalString', () => {
  it.each([
    [1250, 'UAH', '12.50'],
    [-5, 'UAH', '-0.05'],
    [0, 'UAH', '0.00'],
    [500, 'JPY', '500'],
    [-1250, 'KWD', '-1.250'],
  ])('writes %i %s as %s', (minor, currency, expected) => {
    expect(minorToDecimalString(minor, currency)).toBe(expected);
  });
});

describe('formatMoney', () => {
  it('groups thousands with non-breaking spaces and puts the symbol after, the Ukrainian way', () => {
    expect(formatMoney(1_234_567, 'UAH')).toBe(`12${NBSP}345,67${NBSP}₴`);
    expect(formatMoney(999, 'UAH')).toBe(`9,99${NBSP}₴`);
    expect(formatMoney(100_000_000, 'USD')).toBe(`1${NBSP}000${NBSP}000,00${NBSP}$`);
  });

  it('shows money out with a real minus and money in with a plus only on request', () => {
    expect(formatMoney(-5_000, 'UAH')).toBe(`−50,00${NBSP}₴`);
    expect(formatMoney(5_000, 'UAH')).toBe(`50,00${NBSP}₴`);
    expect(formatMoney(5_000, 'UAH', { sign: 'always' })).toBe(`+50,00${NBSP}₴`);
    expect(formatMoney(-5_000, 'UAH', { sign: 'never' })).toBe(`50,00${NBSP}₴`);
  });

  it('rounds half away from zero when asked to drop the fraction, and never shows -0', () => {
    expect(formatMoney(12_350, 'UAH', { fraction: false })).toBe(`124${NBSP}₴`);
    expect(formatMoney(-12_350, 'UAH', { fraction: false })).toBe(`−124${NBSP}₴`);
    expect(formatMoney(-20, 'UAH', { fraction: false })).toBe(`0${NBSP}₴`);
  });

  it('falls back to the currency code and handles currencies without minor units', () => {
    expect(formatMoney(1_000, 'CHF')).toBe(`10,00${NBSP}CHF`);
    expect(formatMoney(1_500, 'JPY')).toBe(`1${NBSP}500${NBSP}JPY`);
  });
});

describe('moneyParts', () => {
  it('keeps whole and fraction apart so the screens can set them in different sizes', () => {
    expect(moneyParts(-123_405, 'UAH')).toEqual({
      negative: true,
      whole: `1${NBSP}234`,
      fraction: '05',
      symbol: '₴',
    });
  });
});
