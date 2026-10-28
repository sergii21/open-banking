import type { Institution, InstitutionQuery } from '@ledger-lens/contracts';

export const MONOBANK_INSTITUTION_ID = 'monobank:monobank';

/**
 * monobank has no consent redirect for individuals. The customer issues a personal token at api.monobank.ua and pastes
 * it in. The terms there limit this to personal and family use, which is why the provider only runs on this machine.
 */
export function monobankInstitutions(query: InstitutionQuery): Institution[] {
  const institution: Institution = {
    id: MONOBANK_INSTITUTION_ID,
    provider: 'monobank',
    mode: 'live',
    name: 'monobank',
    country: 'UA',
    currencies: ['UAH', 'USD', 'EUR'],
    logoUrl: null,
    capabilities: { accounts: true, payments: false },
    health: 'operational',
    paymentsNote: null,
    fixedPayee: false,
    connectMethod: 'token',
    tokenHelp: {
      url: 'https://api.monobank.ua/',
      steps: [
        'Open api.monobank.ua and sign in by scanning the QR code with the monobank app.',
        'Copy the token it shows. The token is read-only: it can see your accounts, balances and statements but cannot move money.',
        'Paste it below. It is encrypted on this machine and is never shown again.',
      ],
      revokeNote:
        'Removing the connection deletes the token and every account and transaction stored here. The token itself stays valid at monobank until you issue a new one at api.monobank.ua.',
    },
  };
  const needle = query.q?.toLowerCase();
  const matches =
    (!query.country || query.country.toUpperCase() === institution.country) &&
    (!needle || institution.name.toLowerCase().includes(needle));
  return matches ? [institution] : [];
}
