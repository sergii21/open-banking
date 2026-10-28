import { describe, expect, it } from 'vitest';
import { isValidIban, maskAccountNumber, maskIdentifier, normalizeIban } from './iban';

describe('isValidIban', () => {
  it.each([
    'DE89 3704 0044 0532 0130 00',
    'GB82WEST12345698765432',
    'FR1420041010050500013M02606',
    'nl91abna0417164300',
    'IE29AIBK93115212345678',
  ])('accepts %s', (iban) => {
    expect(isValidIban(iban)).toBe(true);
  });

  it.each([
    'DE89370400440532013001', // wrong checksum
    'DE8937040044053201300', // too short
    'XX89370400440532013000', // unknown country
    '1234',
    '',
    'GB82 WEST 1234 5698 7654 3!',
  ])('rejects %j', (iban) => {
    expect(isValidIban(iban)).toBe(false);
  });
});

describe('normalizeIban / masking', () => {
  it('strips separators and upper-cases', () => {
    expect(normalizeIban('de89 3704-0044 0532 0130 00')).toBe('DE89370400440532013000');
  });

  it('keeps only the country and last four characters when masking', () => {
    expect(maskIdentifier('DE89370400440532013000')).toBe('DE•• •••• •••• 3000');
    expect(maskAccountNumber('12345678')).toBe('•••• 5678');
  });
});
