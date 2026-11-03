import { createHash } from 'node:crypto';
import { type Calendar, addDays } from '../../../domain/calendar';

/** The wire shapes of monobank's personal API, as the fake serves them. */
export interface DemoAccount {
  id: string;
  sendId: string;
  balance: number;
  creditLimit: number;
  type: string;
  currencyCode: number;
  cashbackType: string;
  maskedPan: string[];
  iban: string;
}
export interface DemoJar {
  id: string;
  sendId: string;
  title: string;
  description: string;
  currencyCode: number;
  balance: number;
  goal: number;
}
export interface DemoItem {
  id: string;
  time: number;
  description: string;
  mcc?: number;
  originalMcc?: number;
  hold?: boolean;
  amount: number;
  operationAmount?: number;
  currencyCode: number;
  commissionRate?: number;
  cashbackAmount?: number;
  balance?: number;
  comment?: string;
  receiptId?: string;
  invoiceId?: string;
  counterEdrpou?: string;
  counterIban?: string;
  counterName?: string;
}
export interface Dataset {
  clientId: string;
  name: string;
  accounts: DemoAccount[];
  jars: DemoJar[];
  /** Statement items per account or jar id, newest first. */
  items: Map<string, DemoItem[]>;
}

export const DEFAULT_HISTORY_DAYS = 100;
const UAH = 980;
const USD = 840;

// ------------------------------------------------------------------------------------------------ randomness

function hashSeed(text: string): number {
  return createHash('sha1').update(text).digest().readUInt32LE(0);
}
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rng = () => number;
const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length)];
const weighted = <T extends { w: number }>(rng: Rng, list: readonly T[]): T => {
  const total = list.reduce((sum, item) => sum + item.w, 0);
  let roll = rng() * total;
  for (const item of list) {
    roll -= item.w;
    if (roll <= 0) return item;
  }
  return list[list.length - 1];
};
/** An amount between two bounds, skewed towards the small end like real purchases. */
const amountBetween = (rng: Rng, min: number, max: number): number => {
  const raw = min + rng() ** 2.1 * (max - min);
  const style = rng();
  const rounded = style < 0.25 ? Math.round(raw / 10) * 10 : style < 0.4 ? Math.round(raw) : raw;
  return Math.max(100, Math.round(rounded * 100));
};
const opaqueId = (...parts: (string | number)[]): string =>
  createHash('sha1').update(parts.join('|')).digest('base64url').slice(0, 12);
const receipt = (rng: Rng): string =>
  Array.from({ length: 4 }, () =>
    Array.from(
      { length: 4 },
      () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(rng() * 32)],
    ).join(''),
  ).join('-');

// ------------------------------------------------------------------------------------------------ merchants

interface Merchant {
  name: string;
  mcc: number;
  min: number;
  max: number;
  w: number;
}
const m = (name: string, mcc: number, min: number, max: number, w = 1): Merchant => ({
  name,
  mcc,
  min,
  max,
  w,
});

const GROCERIES: Merchant[] = [
  m('Сільпо', 5411, 40, 520, 5),
  m('АТБ-маркет', 5411, 30, 420, 6),
  m('Фора', 5411, 30, 380, 4),
  m('Novus', 5411, 90, 900, 2),
  m('Ашан', 5411, 300, 2000, 0.25),
  m('Рукавичка', 5411, 25, 260, 2),
  m('Продукти', 5499, 20, 180, 3),
];
const DINING: Merchant[] = [
  m('Aroma Kava', 5814, 55, 190, 6),
  m('Starbucks', 5814, 110, 300, 3),
  m("McDonald's", 5814, 80, 380, 3),
  m('Львівська майстерня шоколаду', 5441, 70, 320, 2),
  m('Mafia', 5812, 380, 1200, 0.4),
  m('Пузата Хата', 5812, 220, 700, 0.6),
  m('Glovo', 5814, 220, 750, 2),
  m('Bolt Food', 5814, 190, 650, 1.5),
  m('KFC', 5814, 120, 420, 2),
];
const TRANSPORT: Merchant[] = [
  m('Uklon', 4121, 65, 260, 7),
  m('Bolt', 4121, 55, 230, 5),
  m('Київ Цифровий', 4111, 8, 20, 4),
  m('WOG', 5541, 700, 2000, 0.5),
  m('ОККО', 5541, 650, 1900, 0.5),
  m('Укрзалізниця', 4112, 300, 1100, 0.2),
];
const SHOPPING: Merchant[] = [
  m('Rozetka', 5311, 300, 4000, 1),
  m('Нова пошта', 4215, 60, 420, 3),
  m('Епіцентр', 5200, 150, 2600, 0.5),
  m('Zara', 5651, 800, 3400, 0.3),
  m('Sinsay', 5651, 200, 1300, 1),
  m('Comfy', 5732, 1000, 12000, 0.15),
  m('Eva', 5912, 120, 900, 2),
  m('Allo', 5732, 500, 6800, 0.15),
  m('IKEA', 5712, 250, 6400, 0.1),
];
const HEALTH: Merchant[] = [
  m('Аптека Подорожник', 5912, 80, 600, 3),
  m('Аптека Доброго Дня', 5912, 70, 500, 3),
  m('Добробут', 8011, 500, 2200, 0.3),
];
const FUN: Merchant[] = [
  m('Multiplex', 7832, 180, 600, 2),
  m('Steam', 5816, 120, 1100, 1),
  m('Планета Кіно', 7832, 150, 520, 1),
];
const FOREIGN: Merchant[] = [
  m('Amazon.com', 5942, 8, 85, 3),
  m('Apple.com/bill', 5818, 1, 14, 2),
  m('Booking.com', 7011, 90, 420, 1),
  m('Wise', 6012, 50, 200, 0.5),
  m('Google *Cloud', 7372, 5, 30, 1),
];

// ------------------------------------------------------------------------------------------------ generation

interface Draft extends Omit<DemoItem, 'id' | 'time' | 'balance'> {
  /** Seconds since local midnight. */
  at: number;
}

const HOUR_WEIGHTS = [
  0.2, 0.1, 0.05, 0.05, 0.05, 0.2, 0.6, 1.4, 2.4, 2, 1.6, 2, 3, 3, 2, 1.6, 1.8, 2.4, 3, 3, 2.4, 1.6,
  1, 0.5,
];
function secondOfDay(rng: Rng, earliestHour = 0): number {
  const hours = HOUR_WEIGHTS.map((w, h) => ({ w: h < earliestHour ? 0 : w, h }));
  const hour = weighted(rng, hours).h;
  return hour * 3600 + Math.floor(rng() * 3600);
}

const SMALL_TALK = [
  'За каву',
  'Дякую!',
  'Борг',
  'З днем народження 🎉',
  'Квиток',
  'За піцу',
  'Обід',
];
const FIRST = ['Олена', 'Іван', 'Марина', 'Олег', 'Софія', 'Андрій', 'Наталія', 'Максим'];
const LAST = ['К.', 'П.', 'В.', 'Т.', 'Д.', 'Ш.', 'Б.'];
const person = (rng: Rng): string => `${pick(rng, FIRST)} ${pick(rng, LAST)}`;

function purchase(rng: Rng, merchant: Merchant, cashbackPercent: number, currency = UAH): Draft {
  const amount = amountBetween(rng, merchant.min, merchant.max);
  return {
    at: secondOfDay(rng, 7),
    description: merchant.name,
    mcc: merchant.mcc,
    originalMcc: merchant.mcc,
    amount: -amount,
    operationAmount: -amount,
    currencyCode: currency,
    cashbackAmount: cashbackPercent > 0 ? Math.round((amount * cashbackPercent) / 100) : 0,
    commissionRate: 0,
  };
}

function blackCardDay(rng: Rng, day: string, dom: number, weekday: number): Draft[] {
  const weekend = weekday === 0 || weekday === 6;
  const drafts: Draft[] = [];
  const count = Math.round((weekend ? 12 : 9) + (rng() - 0.5) * 6);
  const mix: { w: number; list: Merchant[]; cashback: number }[] = [
    { w: 38, list: GROCERIES, cashback: 1 },
    { w: 22, list: DINING, cashback: 2 },
    { w: 22, list: TRANSPORT, cashback: 1 },
    { w: 6, list: SHOPPING, cashback: 1 },
    { w: 5, list: HEALTH, cashback: 0 },
    { w: 3, list: FUN, cashback: 1 },
  ];
  for (let i = 0; i < count; i += 1) {
    const group = weighted(rng, mix);
    drafts.push(purchase(rng, weighted(rng, group.list), group.cashback));
  }
  // A foreign purchase on the hryvnia card: the amount is in UAH, the operation in dollars (and monobank does not say so).
  if (rng() < 0.05) {
    const usd = amountBetween(rng, 5, 70);
    drafts.push({
      at: secondOfDay(rng, 9),
      description: pick(rng, ['Amazon.com', 'Netflix.com', 'AliExpress']),
      mcc: 5942,
      originalMcc: 5942,
      amount: -Math.round(usd * 41.3),
      operationAmount: -usd,
      currencyCode: UAH,
      cashbackAmount: 0,
      commissionRate: 0,
    });
  }
  // People: money in and out.
  if (rng() < 0.3) {
    const who = person(rng);
    const sum = amountBetween(rng, 100, 2500);
    const commission = rng() < 0.4 ? Math.round(sum * 0.01) + 500 : 0;
    drafts.push({
      at: secondOfDay(rng, 9),
      description: `Кому: ${who}`,
      mcc: 4829,
      originalMcc: 4829,
      amount: -(sum + commission),
      operationAmount: -sum,
      currencyCode: UAH,
      commissionRate: commission,
      cashbackAmount: 0,
      comment: rng() < 0.5 ? pick(rng, SMALL_TALK) : undefined,
      receiptId: receipt(rng),
    });
  }
  if (rng() < 0.22) {
    const sum = amountBetween(rng, 80, 1800);
    drafts.push({
      at: secondOfDay(rng, 9),
      description: `Від: ${person(rng)}`,
      mcc: 4829,
      originalMcc: 4829,
      amount: sum,
      operationAmount: sum,
      currencyCode: UAH,
      cashbackAmount: 0,
      commissionRate: 0,
      comment: rng() < 0.6 ? pick(rng, SMALL_TALK) : undefined,
      receiptId: receipt(rng),
    });
  }
  if (rng() < 0.03) {
    const sum = Math.round(amountBetween(rng, 500, 5000) / 50_000) * 50_000 || 50_000;
    drafts.push({
      at: secondOfDay(rng, 9),
      description: 'Банкомат Приватбанк',
      mcc: 6011,
      originalMcc: 6011,
      amount: -(sum + 1500),
      operationAmount: -sum,
      currencyCode: UAH,
      commissionRate: 1500,
      cashbackAmount: 0,
    });
  }
  // Monthly rhythm.
  const fixed = (description: string, mcc: number, amount: number, hour = 9): void => {
    drafts.push({
      at: hour * 3600 + Math.floor(rng() * 1800),
      description,
      mcc,
      originalMcc: mcc,
      amount: -amount,
      operationAmount: -amount,
      currencyCode: UAH,
      cashbackAmount: 0,
      commissionRate: 0,
    });
  };
  if (dom === 5) {
    drafts.push({
      at: 11 * 3600 + 120,
      description: 'Зарахування заробітної плати',
      mcc: 4829,
      amount: 5_400_000 + Math.round((rng() - 0.5) * 80_000),
      currencyCode: UAH,
      counterName: 'ТОВ «Софтсервіс Україна»',
      receiptId: receipt(rng),
    });
  }
  if (dom === 22) {
    drafts.push({
      at: 13 * 3600 + 200,
      description: 'Від: ФОП Демо Д.',
      mcc: 4829,
      amount: 3_800_000,
      currencyCode: UAH,
      receiptId: receipt(rng),
    });
  }
  if (dom === 20) {
    drafts.push({
      at: 12 * 3600 + 300,
      description: 'Аванс',
      mcc: 4829,
      amount: 2_600_000,
      currencyCode: UAH,
      counterName: 'ТОВ «Софтсервіс Україна»',
      receiptId: receipt(rng),
    });
  }
  if (dom === 2) {
    drafts.push({
      at: 10 * 3600,
      description: 'Кому: Марина В.',
      mcc: 4829,
      originalMcc: 4829,
      amount: -1_600_000,
      operationAmount: -1_600_000,
      currencyCode: UAH,
      comment: 'Оренда',
      receiptId: receipt(rng),
    });
    fixed('Київстар', 4814, 35_000);
    fixed('Gym Sport Life', 7997, 120_000, 8);
  }
  if (dom === 10) fixed('Датагруп', 4814, 28_000);
  if (dom === 8) fixed('Netflix', 4899, 19_900, 3);
  if (dom === 14) fixed('Spotify', 5968, 9_900, 4);
  if (dom === 21) fixed('YouTube Premium', 5968, 11_500, 5);
  if (dom === 12)
    fixed('ДТЕК Київські електромережі', 4900, 90_000 + Math.floor(rng() * 100_000), 13);
  if (dom === 13) fixed('Київводоканал', 4900, 38_000 + Math.floor(rng() * 12_000), 14);
  if (dom === 15) fixed('Київтеплоенерго', 4900, 70_000 + Math.floor(rng() * 90_000), 14);
  if (dom === 3 || dom === 17) {
    drafts.push({
      at: 15 * 3600,
      description:
        dom === 3 ? 'Переказ на банку «На відпустку»' : 'Переказ на банку «Подушка безпеки»',
      mcc: 4829,
      amount: dom === 3 ? -300_000 : -500_000,
      currencyCode: UAH,
    });
  }
  if (dom === 11 || dom === 26) {
    drafts.push({
      at: 16 * 3600,
      description: 'Переказ на кредитну картку',
      mcc: 4829,
      amount: -1_300_000,
      currencyCode: UAH,
    });
  }
  void day;
  return drafts;
}

function creditCardDay(rng: Rng, dom: number, weekday: number): Draft[] {
  const weekend = weekday === 0 || weekday === 6;
  const count = Math.round((weekend ? 4 : 3) + (rng() - 0.5) * 4);
  const mix = [
    { w: 22, list: GROCERIES, cashback: 0 },
    { w: 24, list: DINING, cashback: 0 },
    { w: 16, list: SHOPPING, cashback: 0 },
    { w: 10, list: TRANSPORT, cashback: 0 },
    { w: 6, list: HEALTH, cashback: 0 },
    { w: 5, list: FUN, cashback: 0 },
  ];
  const drafts: Draft[] = [];
  for (let i = 0; i < count; i += 1) {
    const group = weighted(rng, mix);
    drafts.push(purchase(rng, weighted(rng, group.list), 0));
  }
  if (dom === 11 || dom === 26) {
    drafts.push({
      at: 16 * 3600 + 60,
      description: 'Поповнення з картки',
      mcc: 4829,
      amount: 1_300_000,
      currencyCode: UAH,
    });
  }
  return drafts;
}

function usdCardDay(rng: Rng, dom: number): Draft[] {
  const drafts: Draft[] = [];
  if (rng() < 0.35) drafts.push(purchase(rng, weighted(rng, FOREIGN), 0, USD));
  if (dom === 18 && rng() < 0.7) {
    drafts.push({
      at: 14 * 3600,
      description: 'Upwork Escrow',
      mcc: 7399,
      amount: 40_000 + Math.floor(rng() * 40_000),
      currencyCode: USD,
      counterName: 'Upwork Global Inc.',
      receiptId: receipt(rng),
    });
  }
  return drafts;
}

function fopDay(rng: Rng, dom: number, index: number): Draft[] {
  const drafts: Draft[] = [];
  if ([7, 27].includes(dom)) {
    const client = pick(rng, [
      'ТОВ «Нова Лінія»',
      'ТОВ «Технологічні рішення»',
      'ФОП Коваленко С.В.',
    ]);
    drafts.push({
      at: 12 * 3600 + Math.floor(rng() * 7200),
      description: `Оплата за послуги згідно договору №${10 + (index % 40)}`,
      mcc: 4829,
      amount: 2_000_000 + Math.floor(rng() * 1_000_000),
      currencyCode: UAH,
      counterName: client,
      counterEdrpou: String(30_000_000 + Math.floor(rng() * 9_000_000)),
      counterIban: `UA${String(20 + Math.floor(rng() * 70))}322001000002600${String(Math.floor(rng() * 1e10)).padStart(10, '0')}`,
      invoiceId: `${100 + index}.в.${dom}`,
    });
  }
  if (dom === 19) {
    drafts.push({
      at: 10 * 3600,
      description: 'Єдиний податок (3%)',
      mcc: 9311,
      amount: -176_000,
      currencyCode: UAH,
    });
  }
  if (dom === 22) {
    drafts.push({
      at: 11 * 3600,
      description: 'Переказ на власну картку',
      mcc: 4829,
      amount: -3_800_000,
      currencyCode: UAH,
    });
  }
  return drafts;
}

function jarDay(rng: Rng, dom: number, jar: 'trip' | 'safety'): Draft[] {
  if (jar === 'trip' && dom === 3)
    return [
      {
        at: 15 * 3600,
        description: 'Поповнення банки',
        mcc: 4829,
        amount: 300_000,
        currencyCode: UAH,
      },
    ];
  if (jar === 'safety' && dom === 17)
    return [
      {
        at: 15 * 3600,
        description: 'Поповнення банки',
        mcc: 4829,
        amount: 500_000,
        currencyCode: UAH,
      },
    ];
  void rng;
  return [];
}

// ------------------------------------------------------------------------------------------------ assembly

const dayParts = (day: string): { dom: number; weekday: number } => {
  const date = new Date(`${day}T12:00:00Z`);
  return { dom: date.getUTCDate(), weekday: date.getUTCDay() };
};

/** Everything a demo customer "has", relative to now: stable ids and times, so a screen looks the same tomorrow plus a day. */
export function buildDataset(
  now: Date,
  calendar: Calendar,
  seed = 20_261_103,
  historyDays = DEFAULT_HISTORY_DAYS,
): Dataset {
  const today = calendar.today(now);
  const nowSeconds = Math.floor(now.getTime() / 1000);

  const defs = [
    {
      key: 'black',
      id: 'mB5kqXx3fWc7Zp2R',
      balance: 6_425_018,
      type: 'black',
      currency: UAH,
      limit: 0,
      pan: '537541******4242',
      iban: 'UA213220010000026201234567890',
      cashback: 'UAH',
    },
    {
      key: 'credit',
      id: 'pL9vN2sQd8TgYa4M',
      balance: 3_765_945,
      type: 'platinum',
      currency: UAH,
      limit: 5_000_000,
      pan: '444111******7719',
      iban: 'UA583220010000026207654321098',
      cashback: 'Miles',
    },
    {
      key: 'usd',
      id: 'hT3wE6yUo1KcBn8J',
      balance: 128_430,
      type: 'white',
      currency: USD,
      limit: 0,
      pan: '537541******0393',
      iban: 'UA663220010000026203456789012',
      cashback: 'None',
    },
    {
      key: 'fop',
      id: 'cV7dR4mZk0XsLq5A',
      balance: 12_654_000,
      type: 'fop',
      currency: UAH,
      limit: 0,
      pan: '537541******5518',
      iban: 'UA453220010000026009876543210',
      cashback: 'None',
    },
  ] as const;
  const jarDefs = [
    {
      key: 'trip' as const,
      id: 'jA2xP6fHq9RtMw3E',
      title: 'На відпустку',
      description: 'Греція, серпень',
      balance: 5_430_000,
      goal: 12_000_000,
    },
    {
      key: 'safety' as const,
      id: 'jK8bS1nGv5DyUz7C',
      title: 'Подушка безпеки',
      description: '',
      balance: 14_200_000,
      goal: 30_000_000,
    },
  ];

  const items = new Map<string, DemoItem[]>();
  const build = (
    id: string,
    key: string,
    current: number,
    currency: number,
    perDay: (rng: Rng, day: string, dom: number, weekday: number, index: number) => Draft[],
  ): void => {
    const all: DemoItem[] = [];
    for (let back = historyDays - 1; back >= 0; back -= 1) {
      const day = addDays(today, -back);
      const { dom, weekday } = dayParts(day);
      const rng = mulberry32(hashSeed(`${seed}:${key}:${day}`));
      const dayStartSeconds = Math.floor(calendar.dayStart(day) / 1000);
      perDay(rng, day, dom, weekday, historyDays - back).forEach((draft, i) => {
        const time = dayStartSeconds + draft.at;
        if (time > nowSeconds) return;
        const { at: _at, ...rest } = draft;
        void _at;
        const item: DemoItem = {
          id: opaqueId(seed, key, day, i, draft.description),
          time,
          ...rest,
          currencyCode: currency,
        };
        for (const field of Object.keys(item) as (keyof DemoItem)[]) {
          if (item[field] === undefined) delete item[field];
        }
        all.push(item);
      });
    }
    all.sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : 1));
    // Balances run backwards from today's, so every item's balance is the balance after it.
    let running = current;
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const item = all[i];
      item.balance = running;
      running -= item.amount;
    }
    // The last couple of card purchases are still on hold.
    if (key === 'black' || key === 'credit') {
      let holds = 0;
      for (let i = all.length - 1; i >= 0 && holds < 2; i -= 1) {
        const item = all[i];
        if (item.amount < 0 && nowSeconds - item.time < 4 * 3600 && item.mcc !== 4829) {
          item.hold = true;
          holds += 1;
        }
      }
    }
    items.set(id, all.reverse());
  };

  for (const def of defs) {
    const gen = {
      black: (rng: Rng, day: string, dom: number, weekday: number) =>
        blackCardDay(rng, day, dom, weekday),
      credit: (rng: Rng, _day: string, dom: number, weekday: number) =>
        creditCardDay(rng, dom, weekday),
      usd: (rng: Rng, _day: string, dom: number) => usdCardDay(rng, dom),
      fop: (rng: Rng, _day: string, dom: number, _weekday: number, index: number) =>
        fopDay(rng, dom, index),
    }[def.key];
    build(def.id, def.key, def.balance, def.currency, gen);
  }
  for (const jar of jarDefs) {
    build(jar.id, jar.key, jar.balance, UAH, (rng, _day, dom) => jarDay(rng, dom, jar.key));
  }

  return {
    clientId: '3MSaMMtczs',
    name: 'Демо Користувач',
    accounts: defs.map((def) => ({
      id: def.id,
      sendId: def.id.slice(-10),
      balance: def.balance,
      creditLimit: def.limit,
      type: def.type,
      currencyCode: def.currency,
      cashbackType: def.cashback,
      maskedPan: [def.pan],
      iban: def.iban,
    })),
    jars: jarDefs.map((jar) => ({
      id: jar.id,
      sendId: jar.id.slice(-10),
      title: jar.title,
      description: jar.description,
      currencyCode: UAH,
      balance: jar.balance,
      goal: jar.goal,
    })),
    items,
  };
}
