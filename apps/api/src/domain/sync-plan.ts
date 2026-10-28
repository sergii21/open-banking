export interface DateWindow {
  /** Inclusive calendar dates, YYYY-MM-DD. */
  from: string;
  to: string;
}

const DAY_MS = 86_400_000;
const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Contiguous windows of at most `maxDays` days that cover the `months` months up to and including `today`, newest first,
 * so the most useful data lands before the long tail of history.
 */
export function planWindows(today: string, months: number, maxDays: number): DateWindow[] {
  const end = Date.parse(`${today}T00:00:00Z`);
  const anchor = new Date(end);
  const start = Date.UTC(
    anchor.getUTCFullYear(),
    anchor.getUTCMonth() - months,
    anchor.getUTCDate(),
  );

  const windows: DateWindow[] = [];
  let windowEnd = end;
  while (windowEnd >= start) {
    const windowStart = Math.max(windowEnd - (maxDays - 1) * DAY_MS, start);
    windows.push({ from: isoDate(windowStart), to: isoDate(windowEnd) });
    windowEnd = windowStart - DAY_MS;
  }
  return windows;
}
