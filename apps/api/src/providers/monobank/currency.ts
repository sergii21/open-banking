/** ISO 4217 numeric to alphabetic, for the currencies a monobank customer is likely to hold. Unknown codes degrade to `#<code>`. */
const NUMERIC_TO_ALPHA: Readonly<Record<number, string>> = {
  980: 'UAH',
  840: 'USD',
  978: 'EUR',
  826: 'GBP',
  985: 'PLN',
  203: 'CZK',
  756: 'CHF',
  949: 'TRY',
  392: 'JPY',
  124: 'CAD',
  36: 'AUD',
  752: 'SEK',
  578: 'NOK',
  208: 'DKK',
  348: 'HUF',
  946: 'RON',
  975: 'BGN',
  643: 'RUB',
  933: 'BYN',
  398: 'KZT',
  981: 'GEL',
  51: 'AMD',
  944: 'AZN',
  498: 'MDL',
  784: 'AED',
  156: 'CNY',
  344: 'HKD',
  702: 'SGD',
  356: 'INR',
  376: 'ILS',
  818: 'EGP',
  710: 'ZAR',
  410: 'KRW',
  986: 'BRL',
  484: 'MXN',
  764: 'THB',
  704: 'VND',
  608: 'PHP',
  360: 'IDR',
  458: 'MYR',
};

export const isKnownCurrency = (code: number): boolean => code in NUMERIC_TO_ALPHA;

export function currencyFromNumeric(code: number): string {
  return NUMERIC_TO_ALPHA[code] ?? `#${code}`;
}
