import { afterEach, describe, expect, it } from 'vitest';
import { readCsv } from '../src/domain/files/csv';
import { readXlsx } from '../src/domain/files/xlsx';
import { ZipError } from '../src/domain/files/zip';
import { parsePrivat24Statement, StatementError } from '../src/domain/privat24-statement';
import { Client, calendar, createTestApp, type TestApp } from './helpers';
import {
  DATA,
  HEADERS,
  buildCsv,
  buildXlsx,
  serial,
  table,
  zip,
  type Cell,
} from './privat24-fixtures';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const parse = (rows: Cell[][]) =>
  parsePrivat24Statement(readCsv(buildCsv(rows, { delimiter: ';' })), calendar);

describe('reading the files', () => {
  it('reads an Excel workbook: shared strings, numbers, and dates stored as numbers', () => {
    const rows = readXlsx(
      buildXlsx([
        ['Дата', 'Сума'],
        [serial('2026-09-30T18:42:10'), -412.8],
        ['Ф&О <"x">', 'a\nb'],
      ]),
    );
    expect(rows).toEqual([
      ['Дата', 'Сума'],
      ['30.09.2026 18:42:10', '-412.8'],
      ['Ф&О <"x">', 'a\nb'],
    ]);
  });

  it('reads text kept in the cells themselves, and a workbook that is not compressed', () => {
    const rows = [['Дата'], ['01.09.2026'], [12.5]];
    expect(readXlsx(buildXlsx(rows, { strings: 'inline' }))).toEqual([
      ['Дата'],
      ['01.09.2026'],
      ['12.5'],
    ]);
    expect(readXlsx(buildXlsx(rows, { store: true }))).toEqual([
      ['Дата'],
      ['01.09.2026'],
      ['12.5'],
    ]);
  });

  it('refuses what is not a workbook, a damaged one, and one that claims to unpack to more than it should', () => {
    expect(() => readXlsx(Buffer.from('this is not a zip file at all, just text'))).toThrow(
      ZipError,
    );
    expect(() => readXlsx(buildXlsx([['a']]).subarray(0, 60))).toThrow(ZipError);
    expect(() =>
      readXlsx(
        zip(
          { 'xl/workbook.xml': '<workbook/>', 'xl/worksheets/sheet1.xml': 'x'.repeat(1000) },
          { lie: 40 * 1024 * 1024 },
        ),
      ),
    ).toThrow(/too large/);
    expect(() => readXlsx(zip({ 'readme.txt': 'no sheets here' }))).toThrow(ZipError);
  });

  it('reads CSV in UTF-8, with a byte order mark, and in Windows-1251', () => {
    const rows = table();
    for (const encoding of ['utf8', 'utf8-bom', 'cp1251'] as const) {
      const read = readCsv(buildCsv(rows, { encoding }));
      expect(read[0]?.[0]).toBe('Виписка з Ваших карток за період 01.09.2026 - 30.09.2026');
      expect(read[2]).toEqual(HEADERS);
      expect(read[3]?.[3]).toBe('Сільпо, Київ');
    }
  });

  it('finds the delimiter and keeps quoted cells whole', () => {
    expect(readCsv(Buffer.from('a,b,c\r\n1,"x, y",3\r\n"he said ""hi""",\n'))).toEqual([
      ['a', 'b', 'c'],
      ['1', 'x, y', '3'],
      ['he said "hi"', ''],
    ]);
    expect(readCsv(Buffer.from('a\tb\n1\t2\n'))).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(readCsv(Buffer.from('a;b\n"x\ny";2\n'))).toEqual([
      ['a', 'b'],
      ['x\ny', '2'],
    ]);
  });
});

describe('understanding a statement', () => {
  it('finds the header under a title row, uses columns by name, and signs every amount', () => {
    const statement = parse(table());
    expect(statement.rows).toHaveLength(DATA.length);
    expect(statement.period).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(statement.skipped).toBe(0);
    expect(statement.headers.used).toEqual(
      expect.arrayContaining([
        'Дата',
        'Картка',
        'Опис операції',
        'Сума в валюті картки',
        'Валюта картки',
        'Залишок на кінець періоду',
      ]),
    );

    const first = statement.rows[0];
    expect(first).toMatchObject({
      amountMinor: -41_280,
      currency: 'UAH',
      last4: '1234',
      description: 'Сільпо, Київ',
      day: '2026-09-30',
    });
    // 18:42:10 in Kyiv (UTC+3 until 25 October) is 15:42:10 UTC.
    expect(new Date(first?.ts ?? 0).toISOString()).toBe('2026-09-30T15:42:10.000Z');
    expect(
      statement.rows.find((r) => r.description === 'Зарахування заробітної плати')?.amountMinor,
    ).toBe(2_500_000);
    expect(new Set(statement.rows.map((r) => r.last4))).toEqual(new Set(['1234', '5678']));
  });

  it('takes the balance of each card from its latest row, not from the first line it sees', () => {
    const statement = parse(table());
    const balance = (last4: string) => statement.rows.find((r) => r.last4 === last4)?.balanceMinor;
    expect(balance('1234')).toBe(1_523_055);
    expect(balance('5678')).toBe(510_000);
  });

  it('gives the same id to the same transaction every time, and a different one to a twin in the same minute', () => {
    const a = parse(table());
    const b = parse(table(DATA.slice(0, 5)));
    const rides = a.rows.filter((r) => r.description === 'Uklon');
    expect(rides).toHaveLength(2);
    expect(rides[0]?.id).not.toBe(rides[1]?.id);
    expect(new Set(a.rows.map((r) => r.id)).size).toBe(a.rows.length);
    // The overlapping rows of a shorter export carry the very same ids.
    expect(b.rows.map((r) => r.id)).toEqual(a.rows.slice(0, 5).map((r) => r.id));
  });

  it('reads Ukrainian-style numbers written as text, in any of the date formats a bank uses', () => {
    const statement = parse([
      ['Дата', 'Опис операції', 'Сума в валюті картки', 'Валюта картки'],
      ['01.09.2026', 'a', '−1 250,00', 'UAH'],
      ['02.09.2026 10:00', 'b', '1 000,5', '₴'],
      ['2026-09-03 11:30:00', 'c', '-0,05', 'грн'],
      ['04/09/26', 'd', '-7,555', 'UAH'],
      ['Всього', '', '3', ''],
    ]);
    expect(statement.rows.map((r) => r.amountMinor)).toEqual([-125_000, 100_050, -5, -756]);
    expect(statement.rows.map((r) => r.day)).toEqual([
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
    ]);
    expect(statement.skipped).toBe(1); // the totals line
    expect(statement.notes.join(' ')).toMatch(/not transactions/);
  });

  it('understands the same columns in Russian and in English', () => {
    const russian = parse([
      ['Дата и время', 'Описание операции', 'Сумма в валюте карты', 'Валюта карты', 'Карта'],
      ['01.09.2026 10:00:00', 'Покупка', -100, 'UAH', '**** 4321'],
      ['02.09.2026 10:00:00', 'Зачисление', 500, 'UAH', '**** 4321'],
    ]);
    expect(russian.rows.map((r) => [r.amountMinor, r.last4])).toEqual([
      [-10_000, '4321'],
      [50_000, '4321'],
    ]);

    const english = parse([
      ['Date', 'Description', 'Amount', 'Currency', 'Card'],
      ['2026-09-01 10:00', 'Coffee', '-3.50', 'USD', '4321'],
      ['2026-09-02 10:00', 'Refund', '3.50', 'USD', '4321'],
    ]);
    expect(english.rows.map((r) => [r.amountMinor, r.currency])).toEqual([
      [-350, 'USD'],
      [350, 'USD'],
    ]);
  });

  it('adds up separate columns for money out and money in', () => {
    const statement = parse([
      ['Дата', 'Опис операції', 'Витрати', 'Надходження', 'Валюта'],
      ['01.09.2026', 'Shop', '120,50', '', 'UAH'],
      ['02.09.2026', 'Pay', '', '1000,00', 'UAH'],
    ]);
    expect(statement.rows.map((r) => r.amountMinor)).toEqual([-12_050, 100_000]);
  });

  it('says so when there is no currency column, and takes hryvnias', () => {
    const statement = parse([
      ['Дата', 'Опис операції', 'Сума'],
      ['01.09.2026', 'Shop', '-120,50'],
      ['02.09.2026', 'Pay', '1000'],
    ]);
    expect(statement.rows.every((r) => r.currency === 'UAH')).toBe(true);
    expect(statement.notes.join(' ')).toMatch(/no currency column/);
  });

  it('works without a title row, and uses the rows themselves for the period', () => {
    const statement = parsePrivat24Statement(
      [HEADERS, ...DATA.slice(0, 3).map((r) => r.map(String))],
      calendar,
    );
    expect(statement.period).toEqual({ from: '2026-09-29', to: '2026-09-30' });
  });

  describe('when the file is not a statement it can read', () => {
    it('lists the column titles it found and none of the values', () => {
      const secrets = ['Сільпо', 'Uklon', '1234', '25000', 'Олена'];
      const bad = [
        ['Звіт про рух коштів'],
        ['Номер', 'Хто', 'Що', 'Скільки'],
        ['1', 'Сільпо, Київ', 'Uklon', '25000'],
        ['2', 'Олена К.', '5168 74** **** 1234', '3000'],
      ];
      let error: unknown;
      try {
        parse(bad);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(StatementError);
      const message = `${(error as StatementError).message} ${(error as StatementError).headers.join(' ')}`;
      expect((error as StatementError).headers).toEqual(['Номер', 'Хто', 'Що', 'Скільки']);
      for (const secret of secrets) expect(message).not.toContain(secret);
    });

    it('refuses a statement without a date, description or amount column', () => {
      expect(() =>
        parse([
          ['Дата', 'Картка'],
          ['01.09.2026', '1234'],
        ]),
      ).toThrow(/needs a date, a description and an amount/);
      expect(() =>
        parse([
          ['Опис операції', 'Сума'],
          ['a', '1'],
        ]),
      ).toThrow(StatementError);
      expect(() => parse([])).toThrow(StatementError);
    });

    it('refuses amounts that all have one sign, because direction would be a guess', () => {
      const rows: Cell[][] = [['Дата', 'Опис операції', 'Сума', 'Валюта']];
      for (let i = 1; i <= 6; i += 1) rows.push([`0${i}.09.2026`, 'x', '100', 'UAH']);
      expect(() => parse(rows)).toThrow(/same sign/);
    });

    it('refuses a statement with the columns of one and no transactions in it', () => {
      expect(() => parse([HEADERS])).toThrow(/no transactions/);
    });
  });
});

const csv = (rows: Cell[][] = table()): Buffer => buildCsv(rows, { encoding: 'utf8-bom' });

async function started(env: Record<string, string> = {}) {
  t = await createTestApp(env);
  const client = new Client(t);
  await client.start();
  return { t, client };
}

describe('importing a statement', () => {
  it('stores the rows as one account per card, valued like any other, and makes the file a connection', async () => {
    const { t, client } = await started();
    const response = await client.upload('/api/imports/privat24', csv());
    expect(response.statusCode).toBe(200);
    const result = response.json();
    expect(result.rows).toEqual({ read: DATA.length, added: DATA.length, updated: 0, skipped: 0 });
    expect(result.period).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(result.cards.map((c: { last4: string }) => c.last4)).toEqual(['1234', '5678']);
    expect(result.connections).toHaveLength(1);
    expect(result.connections[0]).toMatchObject({
      provider: 'privat24',
      kind: 'file',
      bank: 'privatbank',
      historyMonths: 0,
    });

    const home = (await client.get('/api/home')).json();
    expect(home.accounts).toHaveLength(2);
    expect(home.accounts[0]).toMatchObject({
      bank: 'privatbank',
      source: 'file',
      type: 'privat24',
      last4: '1234',
      balanceKnown: true,
      ownMinor: 1_523_055,
      imported: { from: '2026-09-01', to: '2026-09-30' },
    });
    expect(home.hero.ownUahMinor).toBe(1_523_055 + 510_000);
    expect(home.sync).toMatchObject({ phase: 'idle', total: 0 });
    expect(home.demo).toBe(false);

    const activity = (await client.get('/api/activity')).json();
    expect(activity.rows).toHaveLength(DATA.length);
    // The loader has nothing to do for a file.
    expect(await t.ctx.sync.tick()).toBe(0);
    const row = activity.rows.find((r: { description: string }) => r.description === 'NETFLIX.COM');
    expect(row).toMatchObject({
      amountMinor: -29_900,
      category: 'subscriptions',
      status: 'booked',
    });
  });

  it('does not double anything when the same period is imported again, and keeps a category the person chose', async () => {
    const { t, client } = await started();
    await client.upload('/api/imports/privat24', csv());
    const rows = (await client.get('/api/activity')).json().rows as {
      id: string;
      description: string;
    }[];
    const target = rows.find((r) => r.description === 'Aroma Kava');
    expect(
      (await client.patch(`/api/transactions/${target?.id}`, { category: 'groceries' })).statusCode,
    ).toBe(200);

    const again = (await client.upload('/api/imports/privat24', csv())).json();
    expect(again.rows).toMatchObject({ added: 0, updated: DATA.length });
    expect(t.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM transactions')?.n).toBe(DATA.length);
    expect(t.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM connections')?.n).toBe(1);
    const after = (await client.get('/api/activity'))
      .json()
      .rows.find((r: { id: string }) => r.id === target?.id);
    expect(after).toMatchObject({ category: 'groceries', chosen: true });
  });

  it('adds only the new rows of an export that overlaps an earlier one, and widens the period', async () => {
    const { client } = await started();
    await client.upload('/api/imports/privat24', csv(table(DATA.slice(4))));
    const newer: Cell[][] = [
      [
        '05.10.2026 09:00:00',
        'Транспорт',
        '5168 74** **** 1234',
        'Uklon',
        -110,
        'UAH',
        -110,
        'UAH',
        15120.55,
        'UAH',
      ],
      [
        '04.10.2026 21:00:00',
        'Супермаркети',
        '5168 74** **** 1234',
        'Сільпо, Київ',
        -230,
        'UAH',
        -230,
        'UAH',
        15230.55,
        'UAH',
      ],
      ...DATA.slice(2, 7),
    ];
    const rows: Cell[][] = [
      ['Виписка з Ваших карток за період 22.09.2026 - 05.10.2026'],
      [],
      HEADERS,
      ...newer,
    ];
    const result = (
      await client.upload('/api/imports/privat24', buildCsv(rows, { encoding: 'utf8-bom' }))
    ).json();
    // Two rows are newer than the first file, and two of the five earlier ones were not in it either.
    expect(result.rows.added).toBe(4);
    expect(result.rows.updated).toBe(3);
    const home = (await client.get('/api/home')).json();
    const card = home.accounts.find((a: { last4: string }) => a.last4 === '1234');
    expect(card.imported).toEqual({ from: '2026-09-01', to: '2026-10-05', at: expect.any(String) });
    expect(card.ownMinor).toBe(1_512_055); // the newer statement's balance
  });

  it('never lets an older statement replace the balance a newer one brought', async () => {
    const { client } = await started();
    const june: Cell[][] = [
      ['Виписка з Ваших карток за період 01.06.2026 - 30.06.2026'],
      [],
      HEADERS,
      [
        '30.06.2026 12:00:00',
        'Кафе',
        '5168 74** **** 1234',
        'Aroma Kava',
        -100,
        'UAH',
        -100,
        'UAH',
        777,
        'UAH',
      ],
    ];
    await client.upload('/api/imports/privat24', csv());
    await client.upload('/api/imports/privat24', buildCsv(june, { encoding: 'utf8-bom' }));
    const card = (await client.get('/api/home'))
      .json()
      .accounts.find((a: { last4: string }) => a.last4 === '1234');
    expect(card.ownMinor).toBe(1_523_055);
    expect(card.imported.from).toBe('2026-06-01');
  });

  it('counts a card whose file carries no balance as unknown, not as zero', async () => {
    const { client } = await started();
    const noBalance = table(
      DATA.map((row) => row.slice(0, 8)),
      HEADERS.slice(0, 8),
    );
    const result = (await client.upload('/api/imports/privat24', csv(noBalance))).json();
    expect(result.cards.every((c: { balanceKnown: boolean }) => !c.balanceKnown)).toBe(true);
    const home = (await client.get('/api/home')).json();
    expect(home.hero).toMatchObject({ ownUahMinor: 0, unknownBalance: 2 });
    expect(
      home.accounts.every(
        (a: { balanceKnown: boolean; ownUahMinor: number | null }) =>
          !a.balanceKnown && a.ownUahMinor === null,
      ),
    ).toBe(true);
    expect(home.trend).toBeNull();
  });

  it('reads the Excel export the same way as the CSV one', async () => {
    const { client } = await started();
    const rows = table(
      DATA.map((row, i) => [
        { ...serial(`2026-09-${String(30 - i).padStart(2, '0')}T12:00:00`) },
        ...row.slice(1),
      ]),
    );
    const result = (await client.upload('/api/imports/privat24', buildXlsx(rows))).json();
    expect(result.rows.read).toBe(DATA.length);
    expect(result.cards).toHaveLength(2);
  });

  it('refuses a file it cannot read with the column titles it found, and stores nothing', async () => {
    const { t, client } = await started();
    const bad = buildCsv([
      ['Номер', 'Хто', 'Що'],
      ['1', 'Сільпо, Київ', '25000'],
    ]);
    const response = await client.upload('/api/imports/privat24', bad);
    expect(response.statusCode).toBe(422);
    const problem = response.json();
    expect(problem.code).toBe('unsupported_file');
    expect(problem.detail).toContain('Columns found: Номер · Хто · Що.');
    expect(problem.detail).not.toContain('Сільпо');
    expect(t.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM connections')?.n).toBe(0);

    const notAWorkbook = zip({ 'a.txt': 'x' });
    expect((await client.upload('/api/imports/privat24', notAWorkbook)).json().code).toBe(
      'unsupported_file',
    );
    expect((await client.upload('/api/imports/privat24', Buffer.alloc(0))).statusCode).toBe(400);
  });

  it('is limited to 5 MB, needs the CSRF token, and only works on your own computer', async () => {
    const { client } = await started();
    expect(
      (await client.upload('/api/imports/privat24', Buffer.alloc(5 * 1024 * 1024 + 1, 'a')))
        .statusCode,
    ).toBe(413);
    expect((await client.upload('/api/imports/privat24', csv(), { csrf: false })).statusCode).toBe(
      403,
    );
    await t?.close();

    const pub = await started({ PUBLIC_URL: 'https://ledger.example.com' });
    const refused = await pub.client.upload('/api/imports/privat24', csv());
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('provider_not_available');
  });

  it('replaces the demo, and disconnecting the file deletes every imported row', async () => {
    const { t, client } = await started();
    await client.post('/api/connection', { mode: 'demo' });
    const result = (await client.upload('/api/imports/privat24', csv())).json();
    expect(result.connections.map((c: { provider: string }) => c.provider)).toEqual(['privat24']);

    const id = result.connections[0].id;
    expect((await client.delete(`/api/connection/${id}`)).statusCode).toBe(204);
    for (const table of ['connections', 'accounts', 'transactions']) {
      expect(t.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n).toBe(0);
    }
  });

  it('puts only column titles and counts into the diagnostics: no description, amount or card number', async () => {
    const { client } = await started();
    await client.upload('/api/imports/privat24', csv());
    const { text } = (await client.get('/api/diagnostics')).json<{ text: string }>();
    expect(text).toContain('statement file');
    expect(text).toContain('Опис операції');
    expect(text).toContain('Privat24 statement');
    for (const secret of ['Сільпо', 'Uklon', '412', '1234', '5678', 'Олена', '15230'])
      expect(text).not.toContain(secret);
  });
});
