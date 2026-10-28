import type { ConnectionStatus, ConsentState } from '@ledger-lens/contracts';

/** Reminders start two weeks before a bank consent ends. */
export const EXPIRING_SOON_DAYS = 14;

const DAY_MS = 86_400_000;

export interface ConsentView {
  state: ConsentState;
  /** Whole days left, rounded up; negative once expired; null when the provider reports no expiry. */
  daysRemaining: number | null;
}

export function consentView(
  consentExpiresAt: string | null,
  status: ConnectionStatus,
  now: Date,
): ConsentView {
  if (status === 'expired') {
    return {
      state: 'expired',
      daysRemaining: consentExpiresAt ? daysBetween(consentExpiresAt, now) : null,
    };
  }
  if (!consentExpiresAt) return { state: 'none', daysRemaining: null };
  const days = daysBetween(consentExpiresAt, now);
  if (new Date(consentExpiresAt).getTime() <= now.getTime())
    return { state: 'expired', daysRemaining: days };
  return { state: days <= EXPIRING_SOON_DAYS ? 'expiring_soon' : 'valid', daysRemaining: days };
}

function daysBetween(iso: string, now: Date): number {
  return Math.ceil((new Date(iso).getTime() - now.getTime()) / DAY_MS);
}

/** True when the stored consent end has passed, so an active connection should be marked expired. */
export function hasConsentExpired(consentExpiresAt: string | null, now: Date): boolean {
  return consentExpiresAt !== null && new Date(consentExpiresAt).getTime() <= now.getTime();
}
