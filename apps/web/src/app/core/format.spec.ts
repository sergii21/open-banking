import { ago, countdown, dayKey, dayLabel, timeZone } from './format';

describe('formatting for the screens', () => {
  it('counts down the way a person reads it', () => {
    expect(countdown(41_200)).toBe('42 s');
    expect(countdown(125_000)).toBe('2:05');
    expect(countdown(-5)).toBe('0 s');
  });

  it('says how long ago, in the unit that matters', () => {
    const now = 1_700_000_000_000;
    expect(ago(now - 2_000, now)).toBe('just now');
    expect(ago(now - 12_000, now)).toBe('12 s ago');
    expect(ago(now - 4 * 60_000, now)).toBe('4 min ago');
    expect(ago(now - 3 * 3_600_000, now)).toBe('3 h ago');
  });

  it('cuts days in the configured zone, not in UTC', () => {
    timeZone.set('Europe/Kyiv');
    // 22:30 UTC on 2 November is already 3 November in Kyiv (UTC+2 in winter).
    expect(dayKey(Date.parse('2026-11-02T22:30:00Z'))).toBe('2026-11-03');
    expect(dayKey(Date.parse('2026-11-02T21:30:00Z'))).toBe('2026-11-02');
  });

  it('names today and yesterday, and dates the rest', () => {
    expect(dayLabel('2026-11-03', '2026-11-03')).toBe('Today');
    expect(dayLabel('2026-11-02', '2026-11-03')).toBe('Yesterday');
    expect(dayLabel('2026-10-28', '2026-11-03')).toMatch(/Wed.*28 Oct/);
  });
});
