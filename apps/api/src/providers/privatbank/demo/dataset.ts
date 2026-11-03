import { addDays, type Calendar } from '../../../domain/calendar';

/**
 * A made-up ФОП with two accounts, shaped like PrivatBank's statements: client payments in, taxes, rent and fees out, now and
 * then a transfer to the owner's own card, plus the items a real statement also holds (a hold in progress, a reversed item, a
 * rejected one, a not-real one) so the adapter's skipping is exercised. Deterministic for a given day and seed. Every name,
 * number and IBAN here is invented; the IBANs do not have valid check digits.
 */
export interface FakeAccount {
  /** The IBAN the API uses to address the account. */
  acc: string;
  /** The short account number that transactions carry as `AUT_MY_ACC`. */
  short: string;
  currency: string;
  /** Own money now, minor units. */
  balanceMinor: number;
}

export interface FakeItem {
  acc: string;
  /** Local calendar day and wall-clock time. */
  day: string;
  hour: number;
  minute: number;
  ts: number;
  type: 'D' | 'C';
  sumMinor: number;
  currency: string;
  /** p in progress, r posted, t reversed, n rejected. */
  state: 'p' | 'r' | 't' | 'n';
  real: 'r' | 'i';
  purpose: string;
  counterparty: string;
  counterpartyAcc: string;
  counterpartyCode: string;
  ref: string;
  id: string;
  /** Carries the National Bank's "ultimate payer" fields, which can hold a passport number. */
  ultimate: boolean;
}

export interface FakeDataset {
  accounts: FakeAccount[];
  /** Oldest first. */
  items: FakeItem[];
  /** The previous operating day: where the interim statement starts. */
  lastDay: string;
}

const pick = <T>(list: readonly [T, ...T[]], random: () => number): T =>
  list[Math.floor(random() * list.length)] ?? list[0];

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Party {
  name: string;
  code: string;
}
interface Expense extends Party {
  purpose: string;
  from: number;
  to: number;
}

const CLIENTS: [Party, ...Party[]] = [
  { name: 'ТОВ "ЗОРЯ-СОФТ"', code: '38201457' },
  { name: 'ТОВ "КАРПАТИ ЛОДЖИСТИК"', code: '41120934' },
  { name: 'ФОП Мельник Олена Василівна', code: '3012458891' },
  { name: 'ТОВ "ДНІПРО ФУД ГРУП"', code: '37744120' },
  { name: 'ПП "ВЕСНА-ПЛЮС"', code: '30556217' },
];
const EXPENSES: [Expense, ...Expense[]] = [
  {
    purpose: 'Оплата за хостинг та домен',
    name: 'ТОВ "ХОСТИНГ ГРУП"',
    code: '39018276',
    from: 400,
    to: 2500,
  },
  {
    purpose: 'Оплата за канцелярські товари',
    name: 'ТОВ "ОФІС-СЕРВІС"',
    code: '35590123',
    from: 300,
    to: 3200,
  },
  {
    purpose: 'Оплата за бухгалтерські послуги',
    name: 'ФОП Савчук Г. М.',
    code: '2917703320',
    from: 1800,
    to: 2400,
  },
  {
    purpose: 'Оплата за рекламні послуги',
    name: 'ТОВ "РЕКЛАМА ПЛЮС"',
    code: '40227781',
    from: 1500,
    to: 14000,
  },
];
const MONTHS = [
  'січень',
  'лютий',
  'березень',
  'квітень',
  'травень',
  'червень',
  'липень',
  'серпень',
  'вересень',
  'жовтень',
  'листопад',
  'грудень',
];

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
const dmy = (day: string): string => `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}`;

/** The weekday before `day` (the bank's previous operating day, ignoring public holidays). */
function previousOperatingDay(day: string): string {
  let d = addDays(day, -1);
  for (;;) {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) return d;
    d = addDays(d, -1);
  }
}

export function buildBusinessDataset(
  now: Date,
  calendar: Calendar,
  seed = 11,
  historyDays = 100,
): FakeDataset {
  const today = calendar.today(now);
  const accUah = 'UA213052990000026007233566001';
  const accUsd = 'UA553052990000026003233566002';
  const lastDay = previousOperatingDay(today);
  const items: FakeItem[] = [];
  let counter = 0;

  const add = (
    random: () => number,
    day: string,
    acc: string,
    currency: string,
    type: 'D' | 'C',
    sumMinor: number,
    purpose: string,
    party: { name: string; code: string },
    extra: Partial<Pick<FakeItem, 'state' | 'real' | 'ultimate'>> = {},
  ): void => {
    const hour = 9 + Math.floor(random() * 9);
    const minute = Math.floor(random() * 60);
    const ts = calendar.toInstant(day, hour, minute, 0);
    if (ts > now.getTime() && (extra.state ?? 'r') !== 'p') return;
    counter += 1;
    const id = String(557000000 + counter * 37 + Math.floor(random() * 30));
    items.push({
      acc,
      day,
      hour,
      minute,
      ts,
      type,
      sumMinor,
      currency,
      state: extra.state ?? 'r',
      real: extra.real ?? 'r',
      purpose,
      counterparty: party.name,
      counterpartyAcc: `2600${Math.floor(random() * 1e10)}`.slice(0, 14),
      counterpartyCode: party.code,
      ref: `DN${Math.floor(random() * 36 ** 8)
        .toString(36)
        .toUpperCase()
        .padStart(8, '0')}`,
      id,
      ultimate: extra.ultimate ?? false,
    });
  };

  for (let back = historyDays; back >= 0; back -= 1) {
    const day = addDays(today, -back);
    const random = rng(seed * 100_003 + Number(day.replaceAll('-', '')));
    const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
    const dom = Number(day.slice(8, 10));
    const month = Number(day.slice(5, 7));
    const weekday = dow !== 0 && dow !== 6;

    if (weekday && random() < 0.55) {
      const client = pick(CLIENTS, random);
      const sum = (5_000 + Math.floor(random() * 85_000)) * 100;
      add(
        random,
        day,
        accUah,
        'UAH',
        'C',
        sum,
        `Оплата за послуги згідно рахунку № ${100 + (counter % 400)} від ${dmy(day)}. ПДВ не передбачено`,
        client,
        {
          ultimate: random() < 0.2,
        },
      );
    }
    if (weekday && random() < 0.35) {
      const expense = pick(EXPENSES, random);
      const sum = (expense.from + Math.floor(random() * (expense.to - expense.from))) * 100;
      add(random, day, accUah, 'UAH', 'D', sum, expense.purpose, expense);
    }
    if (dom === 5)
      add(
        random,
        day,
        accUah,
        'UAH',
        'D',
        1_200_000,
        `Оренда офісу за ${MONTHS[(month + 10) % 12]}`,
        { name: 'ФОП Коваленко Ігор Петрович', code: '2830415577' },
      );
    if (dom === 1)
      add(random, day, accUah, 'UAH', 'D', 15_000, 'Комісія за ведення рахунку', {
        name: 'АТ КБ "ПРИВАТБАНК"',
        code: '14360570',
      });
    if (dom === 20) {
      add(random, day, accUah, 'UAH', 'D', 160_000, 'Єдиний податок, ФОП 3 група', {
        name: 'ГУ ДПС у м. Києві',
        code: '43141267',
      });
      add(random, day, accUah, 'UAH', 'D', 176_000, 'Єдиний соціальний внесок за себе', {
        name: 'ГУ ДПС у м. Києві',
        code: '43141267',
      });
    }
    if (dom === 12 || dom === 27) {
      add(
        random,
        day,
        accUah,
        'UAH',
        'D',
        (25_000 + Math.floor(random() * 15_000)) * 100,
        'Переказ власних коштів на картку',
        { name: 'ФОП Тестовий Тарас Тарасович', code: '3145128800' },
      );
    }
    if (back % 11 === 3) {
      add(
        random,
        day,
        accUsd,
        'USD',
        'C',
        (400 + Math.floor(random() * 2100)) * 100,
        'Payment for services under contract',
        { name: 'NORTHWIND TRADING LLC', code: '' },
      );
    }
  }

  // What a real statement also holds, in the last two days.
  const edge = rng(seed);
  add(edge, today, accUah, 'UAH', 'D', 129_900, 'Оплата за хостинг (в обробці)', EXPENSES[0], {
    state: 'p',
  });
  add(
    edge,
    lastDay,
    accUah,
    'UAH',
    'D',
    100_000,
    'Сторнована оплата (повернення)',
    EXPENSES[1] ?? EXPENSES[0],
    { state: 't' },
  );
  add(
    edge,
    lastDay,
    accUah,
    'UAH',
    'D',
    100_000,
    'Забракований платіж',
    EXPENSES[2] ?? EXPENSES[0],
    { state: 'n' },
  );
  add(
    edge,
    lastDay,
    accUah,
    'UAH',
    'D',
    100_000,
    'Інформаційна проводка (не реальна)',
    EXPENSES[3] ?? EXPENSES[0],
    { real: 'i' },
  );

  items.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));

  // Only posted, real items move a balance. Start high enough that it never dips below zero.
  const balances = new Map<string, number>();
  const lowest = new Map<string, number>();
  for (const item of items) {
    if (item.state !== 'r' || item.real !== 'r') continue;
    const next =
      (balances.get(item.acc) ?? 0) + (item.type === 'C' ? item.sumMinor : -item.sumMinor);
    balances.set(item.acc, next);
    lowest.set(item.acc, Math.min(lowest.get(item.acc) ?? 0, next));
  }
  const opening = (acc: string, floor: number): number =>
    Math.max(0, -(lowest.get(acc) ?? 0)) + floor;
  return {
    accounts: [
      {
        acc: accUah,
        short: '26007233566001',
        currency: 'UAH',
        balanceMinor: (balances.get(accUah) ?? 0) + opening(accUah, 3_000_000),
      },
      {
        acc: accUsd,
        short: '26003233566002',
        currency: 'USD',
        balanceMinor: (balances.get(accUsd) ?? 0) + opening(accUsd, 50_000),
      },
    ],
    items,
    lastDay,
  };
}

export const pad2 = (n: number): string => pad(n);
export { dmy };
