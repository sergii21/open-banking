const IBAN_LENGTHS: Record<string, number> = {
  AT: 20,
  BE: 16,
  BG: 22,
  CH: 21,
  CY: 28,
  CZ: 24,
  DE: 22,
  DK: 18,
  EE: 20,
  ES: 24,
  FI: 18,
  FR: 27,
  GB: 22,
  GR: 27,
  HR: 21,
  HU: 28,
  IE: 22,
  IS: 26,
  IT: 27,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  MC: 27,
  MT: 31,
  NL: 18,
  NO: 15,
  PL: 28,
  PT: 25,
  RO: 24,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
};

/** Upper-case and strip separators: "de89 3704 0044 0532 0130 00" -> "DE89370400440532013000". */
export function normalizeIban(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

/** Country length check plus the ISO 7064 mod-97 checksum. */
export function isValidIban(input: string): boolean {
  const iban = normalizeIban(input);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return false;
  const expected = IBAN_LENGTHS[iban.slice(0, 2)];
  if (expected === undefined || iban.length !== expected) return false;

  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const code = char.charCodeAt(0);
    const value = code >= 65 ? String(code - 55) : char;
    for (const digit of value) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

/** Keeps the country code and the last four characters: "DE•• •••• •••• 3000". */
export function maskIdentifier(value: string): string {
  const clean = normalizeIban(value);
  if (clean.length <= 6) return '••••';
  return `${clean.slice(0, 2)}•• •••• •••• ${clean.slice(-4)}`;
}

/** UK account numbers are shown as "•••• 1234" next to the sort code. */
export function maskAccountNumber(value: string): string {
  return `•••• ${value.slice(-4)}`;
}
