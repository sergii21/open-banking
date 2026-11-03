import type { BankId } from '@ledger-lens/contracts';

/** How a bank is written on the screens. */
export const BANK_NAME: Record<BankId, string> = {
  monobank: 'monobank',
  privatbank: 'PrivatBank',
};
