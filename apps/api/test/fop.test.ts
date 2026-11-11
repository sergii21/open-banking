import { afterEach, describe, expect, it } from 'vitest';
import { Db } from '../src/db/database';
import { migrate, migrations } from '../src/db/migrations';
import { readCsv } from '../src/domain/files/csv';
import { buildFopReport, percentOf, type FopRecord } from '../src/domain/fop-report';
import { parseUkrsibStatement } from '../src/domain/ukrsib-statement';
import { Client, calendar, createTestApp, type TestApp } from './helpers';
import { EUR_LINES, UAH_LINES, UKRSIB_TITLES, ukrsibCsv, ukrsibCsvText } from './ukrsib-fixtures';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const parse = (buffer: Buffer) => parseUkrsibStatement(readCsv(buffer), calendar);
const both = () => [...parse(ukrsibCsv(UAH_LINES)).rows, ...parse(ukrsibCsv(EUR_LINES)).rows];
const records = (): FopRecord[] => both().map((row) => ({ ...row, override: null }));
const TODAY = '2026-11-03';

describe('reading a UKRSIB business statement', () => {
  it('reads Windows-1251 text, one side per row, the account as four digits, and a hryvnia amount for each row', () => {
    const parsed = parse(ukrsibCsv(UAH_LINES));
    expect(parsed.rows).toHaveLength(UAH_LINES.length);
    expect(parsed.skipped).toBe(0);
    expect(parsed.period).toEqual({ from: '2026-02-02', to: '2026-08-03' });
    expect(new Set(parsed.rows.map((r) => r.account))).toEqual(new Set(['0000']));
    expect(parsed.rows.every((r) => r.uahMinor === r.amountMinor)).toBe(true);
    const eur = parse(ukrsibCsv(EUR_LINES)).rows;
    expect(eur[0]).toMatchObject({
      currency: 'EUR',
      direction: 'in',
      amountMinor: 200_000,
      uahMinor: 8_000_000,
    });
  });

  it('tells money from clients from the rest, by the words of the purpose', () => {
    const kinds = both().reduce<Record<string, number>>((n, r) => {
      n[r.kind] = (n[r.kind] ?? 0) + 1;
      return n;
    }, {});
    expect(kinds).toEqual({
      income: 8,
      'currency-sale': 1,
      'own-transfer': 1,
      'other-out': 2,
      'tax-single': 2,
      'tax-levy': 1,
      esv: 1,
    });
  });

  it('gives a row the same id every time, and tells two identical rows apart', () => {
    const again = parse(ukrsibCsv(UAH_LINES)).rows.map((r) => r.id);
    expect(again).toEqual(parse(ukrsibCsv(UAH_LINES)).rows.map((r) => r.id));
    const twice = parse(ukrsibCsv([UAH_LINES[0], UAH_LINES[0]])).rows;
    expect(new Set(twice.map((r) => r.id)).size).toBe(2);
  });

  it('finds the columns by their titles, in any order', () => {
    const text = ukrsibCsvText(UAH_LINES.slice(0, 2));
    const reordered = readCsv(Buffer.from(text, 'utf8')).map((row) => [...row].reverse());
    const table = reordered.map((row) => row.map((cell) => cell));
    expect(parseUkrsibStatement(table, calendar).rows).toHaveLength(2);
  });

  it('refuses a file without the columns, listing the titles it found and none of its values', () => {
    const file = Buffer.from('Номер;Хто;Що\n1;Сільпо, Київ;25000\n', 'utf8');
    try {
      parse(file);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).toContain('not a UKRSIB business statement');
      expect((error as { headers: string[] }).headers).toEqual(['Номер', 'Хто', 'Що']);
    }
  });

  it('leaves out a row with a debit and a credit, or neither, and says so', () => {
    const lines = [
      { ...UAH_LINES[0], debit: '5.00' },
      { ...UAH_LINES[0], credit: undefined },
      UAH_LINES[1],
    ];
    const parsed = parse(ukrsibCsv(lines));
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.skipped).toBe(2);
    expect(parsed.notes.join(' ')).toContain('2 lines were not transactions');
  });

  it('does not count a foreign receipt that has no hryvnia amount', () => {
    const noCoverage = ukrsibCsvText(EUR_LINES).replace(/;"?Гривневе покриття"?$/m, '');
    void noCoverage;
    const lines = EUR_LINES.map((l) => ({ ...l, coverage: '0.00' }));
    const rows = parse(ukrsibCsv(lines)).rows;
    expect(rows.filter((r) => r.kind === 'income').every((r) => r.uahMinor === null)).toBe(true);
    const report = buildFopReport(
      rows.map((r) => ({ ...r, override: null })),
      { year: '2026', singleTaxPercent: 5, today: TODAY },
    );
    expect(report.yearIncomeMinor).toBe(0);
    expect(report.warnings.join(' ')).toContain('no hryvnia amount');
  });
});

describe('the report', () => {
  const report = (rate: 5 | 3 = 5, rows = records()) =>
    buildFopReport(rows, { year: '2026', singleTaxPercent: rate, today: TODAY });

  it('adds income per quarter, in hryvnias, without own transfers and the proceeds of a currency sale', () => {
    const r = report();
    expect(r.periods.map((p) => p.incomeMinor)).toEqual([28_000_000, 26_100_000, 12_050_000, 0]);
    expect(r.periods.map((p) => p.cumulativeMinor)).toEqual([
      28_000_000, 54_100_000, 66_150_000, 66_150_000,
    ]);
    expect(r.yearIncomeMinor).toBe(66_150_000);
    expect(r.currencies).toEqual([{ currency: 'EUR', amountMinor: 350_000, uahMinor: 14_150_000 }]);
  });

  it('works the single tax and the military levy out from the cumulative income, quarter by quarter', () => {
    const r = report();
    expect(r.periods.map((p) => p.singleTaxMinor)).toEqual([1_400_000, 1_305_000, 602_500, 0]);
    expect(r.periods.map((p) => p.levyMinor)).toEqual([280_000, 261_000, 120_500, 0]);
    expect(r.yearSingleTaxMinor).toBe(3_307_500);
    expect(r.yearLevyMinor).toBe(661_500);
    // At 3 percent the same income gives a smaller tax and the same levy.
    expect(report(3).yearSingleTaxMinor).toBe(1_984_500);
    expect(report(3).yearLevyMinor).toBe(661_500);
  });

  it('sets what was paid against the quarter its words name', () => {
    const r = report();
    expect(r.periods.map((p) => p.paidSingleTaxMinor)).toEqual([1_400_000, 1_300_000, 0, 0]);
    expect(r.periods.map((p) => p.paidLevyMinor)).toEqual([280_000, 0, 0, 0]);
    expect(r.periods[2]?.paidEsvMinor).toBe(190_234);
    expect(r.periods[2]?.esvMinimumMinor).toBe(570_702);
  });

  it('says how much of the annual limit the year has used', () => {
    expect(report().limit).toEqual({ limitMinor: 1_009_104_900, usedPercent: 6.6 });
    expect(
      buildFopReport(records(), { year: '2025', singleTaxPercent: 5, today: TODAY }).limit,
    ).toBeNull();
  });

  it('counts a row the person chose to count, and not one they chose to leave out', () => {
    const rows = records().map((r) => {
      if (r.kind === 'currency-sale') return { ...r, override: true };
      if (r.direction === 'in' && r.day === '2026-02-02') return { ...r, override: false };
      return r;
    });
    const r = report(5, rows);
    expect(r.periods[0]?.incomeMinor).toBe(28_000_000 + 6_320_000 - 10_000_000);
    expect(r.rows.filter((x) => x.chosen)).toHaveLength(2);
  });

  it('shows the quarters up to today, and none for a year that has not begun', () => {
    expect(report().periods).toHaveLength(4);
    const early = buildFopReport(records(), {
      year: '2026',
      singleTaxPercent: 5,
      today: '2026-08-10',
    });
    expect(early.periods).toHaveLength(3);
    const future = buildFopReport(records(), { year: '2027', singleTaxPercent: 5, today: TODAY });
    expect(future.periods).toHaveLength(0);
  });

  it('rounds half up in integer arithmetic', () => {
    expect(percentOf(1_000_001, 5)).toBe(50_000);
    expect(percentOf(1_000_010, 5)).toBe(50_001);
    expect(percentOf(0, 5)).toBe(0);
  });

  it('knows the titles it expects', () => {
    expect(UKRSIB_TITLES).toHaveLength(17);
  });
});

async function started() {
  t = await createTestApp();
  const client = new Client(t);
  await client.start();
  return { t, client };
}

describe('importing for the report', () => {
  it('stores the rows, adds only what is new the second time, and keeps what the person decided', async () => {
    const { client } = await started();
    const first = await client.upload('/api/imports/ukrsib', ukrsibCsv(UAH_LINES));
    expect(first.statusCode).toBe(200);
    expect(first.json().rows).toEqual({
      read: UAH_LINES.length,
      added: UAH_LINES.length,
      updated: 0,
      skipped: 0,
    });
    // The result holds counts and four digits, no name, purpose or amount.
    expect(JSON.stringify(first.json())).not.toContain('Ромашка');
    expect(first.json().accounts).toEqual([
      {
        account: '0000',
        currency: 'UAH',
        from: '2026-02-02',
        to: '2026-08-03',
        rows: UAH_LINES.length,
      },
    ]);

    await client.upload('/api/imports/ukrsib', ukrsibCsv(EUR_LINES));
    const before = (await client.get('/api/fop?year=2026')).json();
    expect(before.yearIncomeMinor).toBe(66_150_000);
    const sale = before.rows.find((r: { kind: string }) => r.kind === 'currency-sale');
    expect(sale.counted).toBe(false);

    const decided = await client.patch(`/api/fop/rows/${sale.id}`, { counted: true });
    expect(decided.statusCode).toBe(200);
    const again = await client.upload('/api/imports/ukrsib', ukrsibCsv(UAH_LINES));
    expect(again.json().rows).toMatchObject({ added: 0, updated: UAH_LINES.length });
    const after = (await client.get('/api/fop?year=2026')).json();
    expect(after.yearIncomeMinor).toBe(66_150_000 + 6_320_000);
    expect(after.rows.find((r: { id: string }) => r.id === sale.id)).toMatchObject({
      counted: true,
      chosen: true,
    });

    await client.patch(`/api/fop/rows/${sale.id}`, { counted: null });
    expect((await client.get('/api/fop?year=2026')).json().yearIncomeMinor).toBe(66_150_000);
  });

  it('answers for the rate asked, and refuses a rate that is not one', async () => {
    const { client } = await started();
    await client.upload('/api/imports/ukrsib', ukrsibCsv(UAH_LINES));
    expect((await client.get('/api/fop?year=2026&rate=3')).json().singleTaxPercent).toBe(3);
    expect((await client.get('/api/fop?rate=7')).statusCode).toBe(400);
  });

  it('refuses a file that is not a statement, with its titles and none of its values', async () => {
    const { client } = await started();
    const response = await client.upload(
      '/api/imports/ukrsib',
      Buffer.from('Номер;Хто;Що\n1;Сільпо, Київ;25000\n', 'utf8'),
    );
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe('unsupported_file');
    expect(response.json().detail).toContain('Columns found: Номер · Хто · Що.');
    expect(response.body).not.toContain('Сільпо');
  });

  it('keeps one session out of another, and forgets the rows on request', async () => {
    const { t, client } = await started();
    await client.upload('/api/imports/ukrsib', ukrsibCsv(UAH_LINES));
    const other = new Client(t);
    await other.start();
    expect((await other.get('/api/fop')).json().hasData).toBe(false);
    const row = (await client.get('/api/fop?year=2026')).json().rows[0];
    expect((await other.patch(`/api/fop/rows/${row.id}`, { counted: false })).statusCode).toBe(404);
    expect((await client.delete('/api/fop')).statusCode).toBe(204);
    expect((await client.get('/api/fop')).json().hasData).toBe(false);
  });

  it('is only for a copy of the app on the person’s own computer', async () => {
    t = await createTestApp({ PUBLIC_URL: 'https://demo.example.com' });
    const client = new Client(t);
    await client.start();
    const response = await client.upload('/api/imports/ukrsib', ukrsibCsv(UAH_LINES));
    expect(response.statusCode).toBe(403);
  });

  it('needs the CSRF header like every write', async () => {
    const { client } = await started();
    const response = await client.upload('/api/imports/ukrsib', ukrsibCsv(UAH_LINES), {
      csrf: false,
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('migration 004_fop_rows', () => {
  it('adds a table and touches nothing that was there; the rows go with their session', () => {
    const db = new Db(':memory:');
    migrate(db, migrations.slice(0, 3));
    db.run(
      `INSERT INTO sessions (id, created_at, last_seen_at) VALUES ('s1', '2026-11-01T10:00:00Z', '2026-11-04T10:00:00Z')`,
    );
    db.run(
      `INSERT INTO connections (id, session_id, provider, kind, status, created_at, updated_at)
       VALUES ('con_a', 's1', 'privat24', 'file', 'active', 'n', 'n')`,
    );
    const before = db.all('SELECT * FROM connections WHERE 1 = 1');
    expect(migrate(db)).toEqual(['004_fop_rows']);
    expect(db.all('SELECT * FROM connections WHERE 2 = 2')).toEqual(before);
    const insert = (override: number | null) =>
      db.run(
        `INSERT INTO fop_rows (session_id, id, ts, day, account, currency, direction, amount_minor, uah_minor,
           counterparty, purpose, kind, override)
         VALUES ('s1', 'r1', 1, '2026-01-01', '0000', 'UAH', 'in', 100, 100, 'x', 'y', 'income', ?)`,
        override,
      );
    insert(null);
    expect(() => insert(1)).toThrow(); // the same row twice in one session
    expect(() => db.run(`UPDATE fop_rows SET override = 5 WHERE id = 'r1'`)).toThrow(); // a decision is yes, no or none
    db.run(`DELETE FROM sessions WHERE id = 's1'`);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM fop_rows')?.n).toBe(0);
    expect(db.all('PRAGMA foreign_key_check')).toEqual([]);
    db.close();
  });
});
