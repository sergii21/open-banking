import { signal } from '@angular/core';

/** The zone days and months are cut in. The server says which (it is also what Home and Insights use). */
export const timeZone = signal('Europe/Kyiv');

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(
  key: string,
  options: Intl.DateTimeFormatOptions,
  locale = 'en-GB',
): Intl.DateTimeFormat {
  const full = `${timeZone()}|${locale}|${key}`;
  let f = formatters.get(full);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, { timeZone: timeZone(), ...options });
    formatters.set(full, f);
  }
  return f;
}

const dayCache = new Map<number, string>();
/** `YYYY-MM-DD` of a moment in the configured zone, cached per quarter hour (a list of thousands costs a few lookups). */
export function dayKey(ms: number): string {
  const bucket = Math.floor(ms / 900_000);
  let key = dayCache.get(bucket);
  if (key === undefined) {
    key = formatter('day', { year: 'numeric', month: '2-digit', day: '2-digit' }, 'en-CA').format(
      ms,
    );
    if (dayCache.size > 20_000) dayCache.clear();
    dayCache.set(bucket, key);
  }
  return key;
}

export const timeOfDay = (ms: number): string =>
  formatter('time', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);

export function dayLabel(key: string, today: string): string {
  if (key === today) return 'Today';
  const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
  if (key === yesterday) return 'Yesterday';
  const date = new Date(`${key}T12:00:00Z`);
  const sameYear = key.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(date);
}

export const longDate = (ms: number): string =>
  formatter('long', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(ms);

export function monthLabel(month: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${month}-15T12:00:00Z`));
}

export function shortDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${iso.slice(0, 10)}T12:00:00Z`));
}

export function ago(from: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - from) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** "41 s" under a minute, "2:05" above. */
export function countdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** `2026-10-31` as `31.10`: how a statement period is written in Ukraine. */
export const ddmm = (day: string): string => `${day.slice(8, 10)}.${day.slice(5, 7)}`;
