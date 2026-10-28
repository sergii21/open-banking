/** monobank reports ISO 4217 numeric currency codes; the rest of the app uses the alphabetic ones. */
const NUMERIC_TO_ALPHA: Readonly<Record<number, string>> = {
  980: 'UAH',
  840: 'USD',
  978: 'EUR',
  826: 'GBP',
  985: 'PLN',
  756: 'CHF',
  203: 'CZK',
  392: 'JPY',
  124: 'CAD',
  36: 'AUD',
  752: 'SEK',
  578: 'NOK',
  208: 'DKK',
  348: 'HUF',
  946: 'RON',
  975: 'BGN',
  949: 'TRY',
  156: 'CNY',
  376: 'ILS',
  398: 'KZT',
  981: 'GEL',
  498: 'MDL',
  784: 'AED',
  356: 'INR',
  986: 'BRL',
  484: 'MXN',
  702: 'SGD',
  344: 'HKD',
  410: 'KRW',
  554: 'NZD',
  710: 'ZAR',
};

/** An unknown code becomes ISO 4217's "no currency" (XXX) rather than a guess, so it can never be summed with real money. */
export function currencyFromNumeric(code: number): string {
  return NUMERIC_TO_ALPHA[code] ?? 'XXX';
}
