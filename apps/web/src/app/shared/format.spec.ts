import { dayHeading, formatDate, formatMoney, formatRelative } from './format';

describe('formatMoney', () => {
  it('formats integer minor units with the currency exponent', () => {
    expect(formatMoney(345_000, 'EUR')).toBe('€3,450.00');
    expect(formatMoney(5, 'GBP')).toBe('£0.05');
    expect(formatMoney(1250, 'JPY')).toBe('JP¥1,250');
  });

  it('shows an explicit sign when asked, and always shows a minus for money out', () => {
    expect(formatMoney(4217, 'EUR', true)).toBe('+€42.17');
    expect(formatMoney(-4217, 'EUR', true)).toBe('-€42.17');
    expect(formatMoney(-4217, 'EUR')).toBe('-€42.17');
    expect(formatMoney(0, 'EUR', true)).toBe('€0.00');
  });

  it('is exact for the classic float traps because it only divides for display', () => {
    expect(formatMoney(1999, 'EUR')).toBe('€19.99');
    expect(formatMoney(115, 'EUR')).toBe('€1.15');
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-10-28T12:00:00Z');

  it.each([
    [0, 'just now'],
    [-30_000, 'just now'],
    [-5 * 60_000, '5 minutes ago'],
    [-2 * 3_600_000, '2 hours ago'],
    [-86_400_000, 'yesterday'],
    [-3 * 86_400_000, '3 days ago'],
  ])('%i ms from now reads "%s"', (offset, expected) => {
    expect(formatRelative(now + offset, now)).toBe(expected);
  });
});

describe('dates', () => {
  it('formats calendar dates in UTC so a day never shifts with the viewer’s timezone', () => {
    expect(formatDate('2027-01-26T00:00:00.000Z', 'long')).toBe('26 January 2027');
  });

  it('labels today and yesterday and spells out older days', () => {
    const now = Date.parse('2026-10-28T09:00:00Z');
    expect(dayHeading('2026-10-28', now)).toBe('Today');
    expect(dayHeading('2026-10-27', now)).toBe('Yesterday');
    expect(dayHeading('2026-10-05', now)).toBe('Mon, 5 Oct 2026');
  });
});
