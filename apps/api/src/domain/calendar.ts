const DAY_MS = 86_400_000;

export const addDays = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

export const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

export const daysInMonth = (month: string): number =>
  new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();

export const addMonths = (month: string, n: number): string => {
  const index = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
};

/**
 * Days and months as the person lives them. Banks send Unix times; a purchase at 23:30 in Kyiv belongs to that day even
 * though it is already tomorrow in UTC, so every "per day" and "per month" figure is cut in one configured time zone.
 */
export class Calendar {
  private readonly dayFormat: Intl.DateTimeFormat;
  private readonly partsFormat: Intl.DateTimeFormat;
  private readonly cache = new Map<number, string>();

  constructor(readonly timeZone: string) {
    this.dayFormat = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    this.partsFormat = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  /** `YYYY-MM-DD` of a moment in the configured zone. Cached per quarter hour: a sorted list of thousands costs a few lookups. */
  dayKey(ms: number): string {
    const bucket = Math.floor(ms / 900_000);
    let key = this.cache.get(bucket);
    if (key === undefined) {
      key = this.dayFormat.format(new Date(ms));
      if (this.cache.size > 20_000) this.cache.clear();
      this.cache.set(bucket, key);
    }
    return key;
  }

  monthKey(ms: number): string {
    return this.dayKey(ms).slice(0, 7);
  }

  private offsetMs(ms: number): number {
    const parts: Record<string, number> = {};
    for (const part of this.partsFormat.formatToParts(new Date(ms))) {
      if (part.type !== 'literal') parts[part.type] = Number(part.value);
    }
    const asUtc = Date.UTC(
      parts['year'] ?? 1970,
      (parts['month'] ?? 1) - 1,
      parts['day'] ?? 1,
      parts['hour'] ?? 0,
      parts['minute'] ?? 0,
      parts['second'] ?? 0,
    );
    return asUtc - Math.floor(ms / 1000) * 1000;
  }

  /**
   * The instant a wall-clock time on a local day happens, in Unix milliseconds. A time inside the hour that daylight saving
   * skips lands just after the gap.
   */
  toInstant(day: string, hour = 0, minute = 0, second = 0): number {
    const guess = Date.parse(`${day}T00:00:00Z`) + ((hour * 60 + minute) * 60 + second) * 1000;
    const first = guess - this.offsetMs(guess);
    return guess - this.offsetMs(first);
  }

  /** The instant a local day begins, in Unix milliseconds. */
  dayStart(day: string): number {
    return this.toInstant(day);
  }

  /** The last millisecond of a local day. */
  dayEnd(day: string): number {
    return this.dayStart(addDays(day, 1)) - 1;
  }

  today(now: Date): string {
    return this.dayKey(now.getTime());
  }
}

/** `n` calendar months from a day, keeping the day of the month where it exists and clamping to the month's end where not. */
export function addMonthsToDay(day: string, n: number): string {
  const [year = 1970, month = 1, dom = 1] = day.split('-').map(Number);
  const lastOfTarget = new Date(Date.UTC(year, month - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1 + n, Math.min(dom, lastOfTarget)))
    .toISOString()
    .slice(0, 10);
}

export interface DateWindow {
  /** Inclusive calendar days, YYYY-MM-DD. */
  from: string;
  to: string;
}

/**
 * Contiguous windows of at most `maxDays` days that cover the `months` months up to and including `today`, newest first,
 * so the most useful data lands before the long tail of history.
 */
export function planWindows(today: string, months: number, maxDays: number): DateWindow[] {
  const start = addMonthsToDay(today, -months);
  const windows: DateWindow[] = [];
  let to = today;
  while (to >= start) {
    const from = addDays(to, -(maxDays - 1)) < start ? start : addDays(to, -(maxDays - 1));
    windows.push({ from, to });
    to = addDays(from, -1);
  }
  return windows;
}
