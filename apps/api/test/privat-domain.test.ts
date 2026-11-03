import { describe, expect, it } from 'vitest';
import { decimalToMinor } from '../src/domain/decimal';
import { RateTable } from '../src/domain/rates';
import { redactHeaders, redactJson, redactUrl } from '../src/domain/redact';
import { balanceTrend } from '../src/domain/trend';
import { calendar } from './helpers';

describe('decimalToMinor', () => {
  it('reads amounts as text without a float in between', () => {
    expect(decimalToMinor('1234.50', 2)).toBe(123_450);
    expect(decimalToMinor('1 234,5', 2)).toBe(123_450);
    expect(decimalToMinor('-0.01', 2)).toBe(-1);
    expect(decimalToMinor('+12', 2)).toBe(1200);
    expect(decimalToMinor('−7,555', 2)).toBe(-756); // half away from zero
    expect(decimalToMinor('0.30000000000000004', 2)).toBe(30);
    expect(decimalToMinor('1234', 0)).toBe(1234);
    expect(decimalToMinor('12.345', 3)).toBe(12_345);
    expect(decimalToMinor('9007199254740993', 2)).toBeNull(); // would not stay an exact integer
  });

  it('says no to anything that is not a plain number', () => {
    for (const text of ['', ' ', 'abc', '12abc', '1.2.3', '₴12', '12-', '--1']) {
      expect(decimalToMinor(text, 2), text).toBeNull();
    }
  });
});

describe('Calendar.toInstant', () => {
  it('turns Kyiv wall-clock time into the right instant in winter and in summer', () => {
    expect(new Date(calendar.toInstant('2026-11-03', 12, 5, 30)).toISOString()).toBe(
      '2026-11-03T10:05:30.000Z',
    );
    expect(new Date(calendar.toInstant('2026-07-01', 12, 0, 0)).toISOString()).toBe(
      '2026-07-01T09:00:00.000Z',
    );
    expect(calendar.toInstant('2026-11-03')).toBe(calendar.dayStart('2026-11-03'));
  });

  it('handles the days the clocks change', () => {
    // 29 March 2026: 03:00 became 04:00 (UTC+2 to UTC+3). 25 October 2026: 04:00 became 03:00.
    expect(new Date(calendar.toInstant('2026-03-29', 5, 0, 0)).toISOString()).toBe(
      '2026-03-29T02:00:00.000Z',
    );
    expect(new Date(calendar.toInstant('2026-10-25', 5, 0, 0)).toISOString()).toBe(
      '2026-10-25T03:00:00.000Z',
    );
  });
});

describe('redaction of PrivatBank answers', () => {
  const row = {
    acc: 'UA213052990000026007233566001',
    nameACC: 'ФОП Тестовий Тарас Тарасович',
    AUT_MY_ACC: '26007233566001',
    AUT_MY_CRF: '3145128800',
    AUT_MY_NAM: 'ФОП Тестовий Тарас Тарасович',
    AUT_CNTR_ACC: '26001234567890',
    AUT_CNTR_CRF: '38201457',
    AUT_CNTR_NAM: 'ТОВ "ЗОРЯ-СОФТ"',
    OSND: 'Оплата за послуги',
    ULTMT: 'Y',
    PAYER_ULTMT_DOCUMENT: 'КК123456',
    PAYER_ULTMT_NAME: 'Фізична особа',
    RECIPIENT_ULTMT_NCEO: '',
    SUM: '12345.67',
  };

  it('masks accounts, tax ids and the business’s own name when the bank is a live one', () => {
    const text = JSON.stringify(redactJson({ transactions: [row] }, { maskIdentifiers: true }));
    for (const secret of [
      'UA213052990000026007233566001',
      '26007233566001',
      '3145128800',
      '38201457',
      'Тестовий',
      '26001234567890',
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    // The part that is the point of the drawer stays: who paid, what for, how much.
    expect(text).toContain('ТОВ \\"ЗОРЯ-СОФТ\\"');
    expect(text).toContain('Оплата за послуги');
    expect(text).toContain('12345.67');
    expect(text).toContain('•••••••••••••••••••••••6001'.slice(0, 8)); // the first bullets of a masked IBAN
  });

  it('hides the ultimate payer and recipient fields in every mode, and shows an empty one as empty', () => {
    for (const maskIdentifiers of [true, false]) {
      const out = redactJson(row, { maskIdentifiers }) as Record<string, unknown>;
      expect(out['PAYER_ULTMT_DOCUMENT']).toBe('[redacted]');
      expect(out['PAYER_ULTMT_NAME']).toBe('[redacted]');
      expect(out['RECIPIENT_ULTMT_NCEO']).toBe('');
      expect(out['ULTMT']).toBe('Y'); // only says whether they are filled in
    }
  });

  it('hides the key header and the account in the address', () => {
    expect(
      redactHeaders({ token: 'abc123', 'content-type': 'application/json;charset=utf8' }),
    ).toEqual({
      token: '[redacted]',
      'content-type': 'application/json;charset=utf8',
    });
    const url =
      'https://acp.privatbank.ua/api/statements/transactions?acc=UA213052990000026007233566001&startDate=01-10-2026&limit=100';
    expect(redactUrl(url, { maskIdentifiers: true })).toMatch(
      /acc=•+6001&startDate=01-10-2026&limit=100$/,
    );
    expect(redactUrl(url, { maskIdentifiers: true })).not.toContain('UA2130529900');
    expect(redactUrl(url)).toContain('UA213052990000026007233566001'); // fake bank data is shown as it is
  });
});

describe('the 30-day line for a bank that reports no balance after each item', () => {
  const table = new RateTable([]);
  const days = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'];
  const end = (day: string): number => calendar.dayEnd(day);
  const at = (day: string, hour: number): number => calendar.toInstant(day, hour);

  it('walks back from the balance now over the items that came after each day', () => {
    const result = balanceTrend(
      [
        {
          currency: 'UAH',
          creditLimitMinor: 0,
          currentBalanceMinor: 10_000,
          coveredFrom: '2026-10-01',
          isJar: false,
          rows: [],
          flows: [
            { ts: at('2026-11-02', 10), amountMinor: -500 },
            { ts: at('2026-11-03', 9), amountMinor: 2_000 },
            { ts: at('2026-11-04', 9), amountMinor: -300 },
          ],
        },
      ],
      days,
      end,
      table,
    );
    // Now 10 000; 4 Nov spent 300 (so 3 Nov ended at 10 300), 3 Nov received 2 000 (so 2 Nov ended at 8 300), 2 Nov spent 500.
    expect(result?.points).toEqual([8_800, 8_300, 10_300, 10_000]);
  });

  it('says nothing until the history reaches the first day', () => {
    const result = balanceTrend(
      [
        {
          currency: 'UAH',
          creditLimitMinor: 0,
          currentBalanceMinor: 10_000,
          coveredFrom: '2026-11-03',
          isJar: false,
          rows: [],
          flows: [],
        },
      ],
      days,
      end,
      table,
    );
    expect(result).toBeNull();
  });
});
