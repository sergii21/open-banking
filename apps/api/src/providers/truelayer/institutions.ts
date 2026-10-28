import type { Institution, InstitutionQuery } from '@ledger-lens/contracts';
import type { TrueLayerConfig } from '../../config';

export const TRUELAYER_INSTITUTION_SLUG = 'mock-bank';
export const TRUELAYER_INSTITUTION_ID = `truelayer:${TRUELAYER_INSTITUTION_SLUG}`;
export const TRUELAYER_INSTITUTION_NAME = 'TrueLayer Mock Bank';

/** Currencies the payment form may offer: those the configured beneficiary can actually receive. */
export function payableCurrencies(config: TrueLayerConfig): string[] {
  const { beneficiary } = config;
  if (!config.signing) return [];
  if (beneficiary.type === 'external_account') return ['GBP', 'EUR'];
  return (['GBP', 'EUR'] as const).filter((c) => beneficiary.merchantAccountIds[c]);
}

/**
 * The sandbox exposes one bank to us: TrueLayer's own Mock Bank, with test users. Real banks only appear in live mode,
 * which this project deliberately does not wire up.
 */
export function truelayerInstitutions(
  config: TrueLayerConfig,
  query: InstitutionQuery,
): Institution[] {
  const payable = payableCurrencies(config);
  const institution: Institution = {
    id: TRUELAYER_INSTITUTION_ID,
    provider: 'truelayer',
    mode: 'sandbox',
    name: TRUELAYER_INSTITUTION_NAME,
    country: 'GB',
    currencies: payable.length > 0 ? payable : ['GBP'],
    logoUrl: null,
    capabilities: { accounts: true, payments: payable.length > 0 },
    health: 'operational',
    paymentsNote:
      payable.length === 0
        ? null
        : config.beneficiary.type === 'merchant_account'
          ? 'Sandbox payment into the app’s TrueLayer merchant account. No real money moves, and the payee details you enter are not used.'
          : 'Sandbox payment to the account you enter. No real money moves; the sandbox bank ends the payment at “Executed”.',
  };

  const needle = query.q?.toLowerCase();
  const matches =
    (!query.country || query.country.toUpperCase() === institution.country) &&
    (!needle || institution.name.toLowerCase().includes(needle));
  return matches ? [institution] : [];
}
