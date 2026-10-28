import { currencyExponent } from '@ledger-lens/contracts';

/** Display only: amounts stay integer minor units everywhere else, so rounding never leaks into data. */
export function formatMoney(amountMinor: number, currency: string, signed = false): string {
  const value = amountMinor / 10 ** currencyExponent(currency);
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency,
    ...(signed ? { signDisplay: 'exceptZero' as const } : {}),
  }).format(value);
}

const RELATIVE = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });

/** "just now", "3 minutes ago", "yesterday". */
export function formatRelative(thenMs: number, nowMs: number): string {
  const seconds = Math.round((thenMs - nowMs) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return 'just now';
  if (abs < 3600) return RELATIVE.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return RELATIVE.format(Math.round(seconds / 3600), 'hour');
  if (abs < 86_400 * 30) return RELATIVE.format(Math.round(seconds / 86_400), 'day');
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(thenMs);
}

export function formatDate(iso: string, style: 'short' | 'medium' | 'long' = 'medium'): string {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: style, timeZone: 'UTC' }).format(
    new Date(iso),
  );
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(iso),
  );
}

/** Day heading for grouped lists: "Today", "Yesterday" or "Tue, 27 Oct 2026". */
export function dayHeading(isoDate: string, nowMs: number): string {
  const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  if (isoDate === day(nowMs)) return 'Today';
  if (isoDate === day(nowMs - 86_400_000)) return 'Yesterday';
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${isoDate}T00:00:00Z`));
}
