/**
 * UKRSIB business statement CSVs, made up. The layout is the real one (17 titled columns, `;`, Windows-1251, one debit or one
 * credit per row, "Гривневе покриття" for the hryvnia equivalent), read from a real export of the person's own; every name,
 * number and amount below is invented and the accounts are not anybody's.
 */
export const UKRSIB_TITLES = [
  'ЄДРПОУ',
  'МФО',
  'Рахунок',
  'Валюта',
  'Дата операцiї',
  'Код операцiї',
  'МФО банка',
  'Назва банка',
  'Рахунок кореспондента',
  'ЄДРПОУ кореспондента',
  'Кореспондент',
  'Номер документа',
  'Дата документа',
  'Дебет',
  'Кредит',
  'Призначення платежу',
  'Гривневе покриття',
] as const;

export const OWN_CODE = '3000000001';
export const UAH_ACCOUNT = 'UA113510050000026000000000000';
export const EUR_ACCOUNT = 'UA223510050000026000000000001';
const OWN_NAME = 'Тестовий Іван Петрович';
const CLIENT = 'ТОВ "Ромашка"';
const BANK = 'АТ "УКРСИББАНК"';

export interface UkrsibLine {
  account: string;
  currency: 'UAH' | 'EUR';
  /** DD.MM.YYYY HH:MM */
  when: string;
  debit?: string;
  credit?: string;
  purpose: string;
  counterparty: string;
  /** The hryvnia equivalent of a foreign-currency row; "0.00" on hryvnia rows, as the bank writes it. */
  coverage?: string;
}

const income = (when: string, credit: string): UkrsibLine => ({
  account: UAH_ACCOUNT,
  currency: 'UAH',
  when,
  credit,
  purpose: 'Оплата за послуги згідно договору № LS-1 від 01.01.2026',
  counterparty: CLIENT,
});
const exportRevenue = (when: string, credit: string, coverage: string): UkrsibLine => ({
  account: EUR_ACCOUNT,
  currency: 'EUR',
  when,
  credit,
  coverage,
  purpose: `Зарахування експортної виручки ${credit.replace('.', ',')} EUR, SOME CLIENT LTD`,
  counterparty: OWN_NAME,
});

/** Quarter 1: 280 000 counted (the sale proceeds and the own transfer are not income). Quarter 2: 261 000. Quarter 3: 120 500. */
export const UAH_LINES: UkrsibLine[] = [
  income('02.02.2026 12:00', '100000.00'),
  income('02.03.2026 12:00', '100000.00'),
  {
    account: UAH_ACCOUNT,
    currency: 'UAH',
    when: '20.03.2026 10:00',
    credit: '63200.00',
    purpose: 'Гр.экв.продажу 1000.00 EUR на МВР 63.2000, ЗГІДНО ЗАЯВИ КЛІЄНТА № 1',
    counterparty: BANK,
  },
  income('02.04.2026 12:00', '100000.00'),
  {
    account: UAH_ACCOUNT,
    currency: 'UAH',
    when: '10.04.2026 09:00',
    debit: '50000.00',
    purpose: 'Переказ між власними рахунками',
    counterparty: OWN_NAME,
  },
  {
    account: UAH_ACCOUNT,
    currency: 'UAH',
    when: '15.04.2026 11:00',
    debit: '18.00',
    purpose: 'Комісія по рах. UA11 UAH за зовнішній платіж СЕП',
    counterparty: BANK,
  },
  {
    account: UAH_ACCOUNT,
    currency: 'UAH',
    when: '20.04.2026 10:00',
    debit: '14000.00',
    purpose: '101 Сплата ЄП за 1-й квартал 2026 року',
    counterparty: 'ГУ ДПС у м. Києві',
  },
  {
    account: UAH_ACCOUNT,
    currency: 'UAH',
    when: '20.04.2026 10:01',
    debit: '2800.00',
    purpose: '101 Сплата військового збору за 1-й квартал 2026 року',
    counterparty: 'ГУ ДПС у м. Києві',
  },
  income('04.05.2026 12:00', '120000.00'),
  {
    account: UAH_ACCOUNT,
    currency: 'UAH',
    when: '20.07.2026 10:00',
    debit: '13000.00',
    purpose: '101 Сплата ЄП за 2-й квартал 2026 року',
    counterparty: 'ГУ ДПС у м. Києві',
  },
  {
    account: UAH_ACCOUNT,
    currency: 'UAH',
    when: '21.07.2026 10:00',
    debit: '1902.34',
    purpose: 'Єдиний внесок за липень 2026',
    counterparty: 'ГУ ДПС у м. Києві',
  },
  income('03.08.2026 12:00', '100000.00'),
];

export const EUR_LINES: UkrsibLine[] = [
  exportRevenue('10.02.2026 12:00', '2000.00', '80000.00'),
  exportRevenue('12.05.2026 12:00', '1000.00', '41000.00'),
  {
    account: EUR_ACCOUNT,
    currency: 'EUR',
    when: '20.05.2026 12:00',
    debit: '1000.00',
    purpose: 'Перерахування коштів для продажу валюти згідно заявки клієнта',
    counterparty: OWN_NAME,
    coverage: '41000.00',
  },
  exportRevenue('08.07.2026 12:00', '500.00', '20500.00'),
];

const quote = (cell: string): string =>
  /[;"\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;

/** The CSV text of some lines, as UKRSIB writes it (before the Windows-1251 encoding). */
export function ukrsibCsvText(
  lines: readonly UkrsibLine[],
  titles: readonly string[] = UKRSIB_TITLES,
): string {
  const head = titles.map((t) => `"${t}"`).join(';');
  const body = lines.map((line, i) => {
    const [day, time] = line.when.split(' ');
    return [
      OWN_CODE,
      '',
      line.account,
      line.currency,
      `${day} ${time}`,
      '99',
      '',
      BANK,
      'UA333510050000026000000000002',
      '12345678',
      line.counterparty,
      String(1000000 + i),
      day,
      line.debit ?? '',
      line.credit ?? '',
      line.purpose,
      line.coverage ?? '0.00',
    ]
      .map((cell) => quote(cell ?? ''))
      .join(';');
  });
  return [head, ...body].join('\r\n') + '\r\n';
}

/** Windows-1251, the encoding of the real file: the Ukrainian letters and the few signs the made-up text uses. */
export function encodeWindows1251(text: string): Buffer {
  const special: Record<string, number> = {
    Ґ: 0xa5,
    ґ: 0xb4,
    Є: 0xaa,
    є: 0xba,
    І: 0xb2,
    і: 0xb3,
    Ї: 0xaf,
    ї: 0xbf,
    '№': 0xb9,
    Ё: 0xa8,
    ё: 0xb8,
  };
  const bytes: number[] = [];
  for (const char of text) {
    const point = char.codePointAt(0) ?? 63;
    if (point < 0x80) bytes.push(point);
    else if (special[char] !== undefined) bytes.push(special[char]);
    else if (point >= 0x410 && point <= 0x44f) bytes.push(point - 0x410 + 0xc0);
    else bytes.push(63);
  }
  return Buffer.from(bytes);
}

export const ukrsibCsv = (lines: readonly UkrsibLine[]): Buffer =>
  encodeWindows1251(ukrsibCsvText(lines));
