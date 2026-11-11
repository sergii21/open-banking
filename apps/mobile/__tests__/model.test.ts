import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NBU_LINK_BASE } from '@ledger-lens/contracts';
import '../src/platform/text-decoder';
import { FopFileError, cabinetNumber, dayText, fopReport, importUkrsib } from '../src/model/fop';
import { buildOverview } from '../src/model/overview';
import { EMPTY_PAY_FORM, payView, readPayText } from '../src/model/pay';
import { kyiv, openStore } from './helpers';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(__dirname, '../../../fixtures/ukrsib', name)));

describe('Pay from pasted text', () => {
  const invoice = [
    'Отримувач: ТОВ "Вигадана компанія"',
    'IBAN: UA213223130000026007233566001',
    'ЄДРПОУ: 12345678',
    'Сума: 1 500,50 грн',
    'Призначення: Оплата за послуги згідно рахунку 17',
  ].join('\n');

  it('an invoice becomes the National Bank’s link and a code to draw', () => {
    const form = readPayText(invoice);
    expect(form).toMatchObject({ kind: 'account', code: '12345678', amount: '1500,50' });
    const view = payView(form);
    expect(view.problems).toEqual({});
    expect(view.link?.startsWith(NBU_LINK_BASE)).toBe(true);
    const fields = Buffer.from((view.link ?? '').slice(NBU_LINK_BASE.length), 'base64url')
      .toString('utf8')
      .split('\n');
    expect(fields).toContain('UA213223130000026007233566001');
    expect(fields).toContain('UAH1500.50');
    expect(view.qr?.path.startsWith('M')).toBe(true);
    expect(view.qr?.size).toBeGreaterThanOrEqual(57);
    expect(view.summary).toMatch(/1\s500,50/);
  });

  it('nothing is called wrong on an empty form, and a wrong IBAN digit is explained', () => {
    expect(payView(EMPTY_PAY_FORM)).toMatchObject({
      started: false,
      problems: {},
      link: null,
      qr: null,
    });
    const form = readPayText(invoice.replace('6001', '6002'));
    const view = payView({ ...form, iban: 'UA213223130000026007233566002' });
    expect(view.problems.iban).toBeTruthy();
    expect(view.link).toBeNull();
  });

  it('an amount that is not money gives no link', () => {
    const view = payView({ ...readPayText(invoice), amount: '12,345' });
    expect(view.amountProblem).toBeTruthy();
    expect(view.link).toBeNull();
  });

  it('a card number alone is a transfer to a card: no code, the number checked', () => {
    const form = readPayText('Скинь 250 грн на 4149 4991 0000 0007 дякую');
    expect(form.kind).toBe('card');
    const view = payView(form);
    expect(view.link).toBeNull();
    expect(view.qr).toBeNull();
    expect(view.cardProblem).toBeNull();
    expect(form.amount).toBe('250,00');
    expect(view.privatLink).toContain('privat24');
    expect(view.cardText).toMatch(/^\d{4} \d{4} \d{4} \d{4}$/);
    expect(payView({ ...form, card: '4149499100000006' }).cardProblem).toContain('check digit');
    expect(payView({ ...form, card: '4149' }).cardProblem).toBe('The card number is 16 digits.');
  });
});

describe('Your money in hryvnias', () => {
  const base = {
    kind: 'card' as const,
    cardType: 'black',
    name: 'x',
    last4: null,
    goalMinor: null,
    sort: 0,
  };
  const rates = [
    { a: 'USD', b: 'UAH', buy: 41.15, sell: 41.6, cross: null, date: 1_700_000_000 },
    { a: 'EUR', b: 'UAH', buy: null, sell: null, cross: 48.123, date: 1_700_000_100 },
  ];

  it('own funds leave the credit limit out, foreign money is valued in whole kopiykas, an unknown currency is left out', () => {
    const overview = buildOverview(
      [
        {
          ...base,
          providerAccountId: 'uah',
          currency: 'UAH',
          balanceMinor: 60_000_00,
          creditLimitMinor: 50_000_00,
        },
        {
          ...base,
          providerAccountId: 'usd',
          currency: 'USD',
          balanceMinor: 100_01,
          creditLimitMinor: 0,
        },
        {
          ...base,
          providerAccountId: 'eur',
          currency: 'EUR',
          balanceMinor: 33,
          creditLimitMinor: 0,
        },
        {
          ...base,
          providerAccountId: 'xxx',
          currency: 'XTS',
          balanceMinor: 5,
          creditLimitMinor: 0,
        },
      ],
      rates,
    );
    expect(overview.accounts.map((a) => [a.id, a.ownMinor, a.uahMinor])).toEqual([
      ['uah', 10_000_00, 10_000_00],
      ['usd', 100_01, 4115_41],
      ['eur', 33, 15_88],
      ['xxx', 5, null],
    ]);
    expect(overview.totalUahMinor).toBe(10_000_00 + 4115_41 + 15_88);
    expect(overview).toMatchObject({ unvalued: 1, converted: true });
    expect(overview.ratesAsOf).toBe(new Date(1_700_000_100_000).toISOString());
  });

  it('with no rates the hryvnia accounts still add up', () => {
    const overview = buildOverview(
      [
        {
          ...base,
          providerAccountId: 'uah',
          currency: 'UAH',
          balanceMinor: 1_00,
          creditLimitMinor: 0,
        },
        {
          ...base,
          providerAccountId: 'usd',
          currency: 'USD',
          balanceMinor: 1_00,
          creditLimitMinor: 0,
        },
      ],
      [],
    );
    expect(overview).toMatchObject({
      totalUahMinor: 1_00,
      unvalued: 1,
      converted: false,
      ratesAsOf: null,
    });
  });
});

describe('the ФОП report on the phone', () => {
  it('reads the made-up UKRSIB statements (Windows-1251) and adds them up per quarter', async () => {
    const store = await openStore();
    const calendar = kyiv();
    const uah = await importUkrsib(store, calendar, fixture('made-up-uah.csv'));
    const eur = await importUkrsib(store, calendar, fixture('made-up-eur.csv'));
    expect(uah.rows.read).toBeGreaterThan(0);
    expect(uah.rows.added).toBe(uah.rows.read);
    expect(eur.accounts.map((a) => a.currency)).toEqual(['EUR']);

    const report = await fopReport(store, '2026-11-11', undefined, 5);
    expect(report).toMatchObject({ year: '2026', hasData: true, singleTaxPercent: 5 });
    expect(report.periods).toHaveLength(4);
    expect(report.yearIncomeMinor).toBeGreaterThan(0);
    expect(Number.isInteger(report.yearIncomeMinor)).toBe(true);
    expect(report.yearIncomeMinor).toBe(report.periods.reduce((sum, p) => sum + p.incomeMinor, 0));
    expect(report.periods[0]?.lines.length).toBeGreaterThan(5);
    expect(report.calendar).toHaveLength(4);
    // Ukrainian text came through the decoder intact.
    expect(report.rows.some((row) => /[а-яіїє]{4}/i.test(row.purpose))).toBe(true);

    // The same file again adds nothing, and a row the person switched off stays off.
    const income = report.rows.find((row) => row.counted);
    await store.setFopOverride(income?.id ?? '', false);
    const again = await importUkrsib(store, calendar, fixture('made-up-uah.csv'));
    expect(again.rows).toMatchObject({ added: 0, updated: uah.rows.read });
    const after = await fopReport(store, '2026-11-11', '2026', 3);
    expect(after.singleTaxPercent).toBe(3);
    expect(after.yearIncomeMinor).toBe(
      report.yearIncomeMinor - (income?.uahMinor ?? income?.amountMinor ?? 0),
    );
    expect(after.rows.find((row) => row.id === income?.id)).toMatchObject({
      counted: false,
      chosen: true,
    });
  });

  it('an all-accounts export does not count the transit account twice', async () => {
    const calendar = kyiv();
    const apart = await openStore();
    await importUkrsib(apart, calendar, fixture('made-up-uah.csv'));
    await importUkrsib(apart, calendar, fixture('made-up-eur.csv'));
    const together = await openStore();
    await importUkrsib(together, calendar, fixture('made-up-all-accounts.csv'));
    const a = await fopReport(apart, '2026-11-11', '2026', 5);
    const b = await fopReport(together, '2026-11-11', '2026', 5);
    expect(b.yearIncomeMinor).toBe(a.yearIncomeMinor);
  });

  it('a file that is not a statement is refused with its column titles and none of its values', async () => {
    const store = await openStore();
    const bytes = new TextEncoder().encode('Назва;Скільки\r\nСекретний клієнт;777000,55\r\n');
    const error = await importUkrsib(store, kyiv(), bytes).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FopFileError);
    expect((error as Error).message).not.toContain('Секретний');
    expect((error as Error).message).not.toContain('777000');
    expect(await store.fopRows()).toEqual([]);
  });

  it('writes numbers the way the tax cabinet takes them, from integer kopiykas', () => {
    expect(cabinetNumber(340_299_273)).toBe('3402992.73');
    expect(cabinetNumber(5)).toBe('0.05');
    expect(cabinetNumber(0)).toBe('0.00');
    expect(cabinetNumber(-1_50)).toBe('-1.50');
    expect(dayText('2026-05-10')).toBe('10 May 2026');
  });
});
