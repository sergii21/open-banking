import type { DatasetProfile, MockInstitution } from './institutions';

/**
 * Deterministic bank data. The same `seed` and calendar day always produce the same transactions, and each day's
 * activity depends only on (seed, date), so the history does not reshuffle as the window slides forward. Balances
 * are derived (opening balance = target - sum of history), so what the bank reports always reconciles exactly.
 */

export type MockAccountType = 'TRANSACTION' | 'SAVINGS' | 'CREDIT_CARD';

export interface MockAccount {
  id: string;
  type: MockAccountType;
  name: string;
  currency: string;
  iban: string | null;
  sortCode: string | null;
  accountNumber: string | null;
  bic: string;
  /** Extra headroom added to "available": overdraft on the current account, credit limit on the card. */
  headroomMinor: number;
}

export interface MockTransaction {
  /** Bank-assigned id. Pending items have none, as with real banks. */
  id: string | null;
  accountId: string;
  /** Calendar date, YYYY-MM-DD. */
  date: string;
  timestamp: string;
  amountMinor: number;
  currency: string;
  description: string;
  merchant: string | null;
  /** Coarse provider-side type: PURCHASE, DIRECT_DEBIT, STANDING_ORDER, CREDIT, TRANSFER, ATM, INTEREST. */
  category: string;
  pending: boolean;
}

export interface MockBalance {
  currentMinor: number;
  availableMinor: number;
}

export interface Dataset {
  accounts: MockAccount[];
  transactions: MockTransaction[];
  balances: Map<string, MockBalance>;
}

export interface ExecutedPayment {
  id: string;
  accountCurrency: string;
  amountMinor: number;
  beneficiaryName: string;
  reference: string;
  executedAt: string;
}

export interface DatasetOptions {
  seed: string;
  institution: MockInstitution;
  profile: DatasetProfile;
  today: Date;
  executedPayments?: readonly ExecutedPayment[];
}

// ---------------------------------------------------------------------------------------------- randomness

function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rngFor = (seed: string, key: string): (() => number) => mulberry32(hash32(`${seed}|${key}`));
const pick = <T>(rng: () => number, items: readonly T[]): T =>
  items[Math.floor(rng() * items.length)];
const between = (rng: () => number, min: number, max: number): number =>
  min + Math.floor(rng() ** 1.5 * (max - min + 1));
const digits = (rng: () => number, n: number): string =>
  Array.from({ length: n }, () => Math.floor(rng() * 10)).join('');

// ---------------------------------------------------------------------------------------------- dates (UTC)

const DAY_MS = 86_400_000;
const addDays = (date: Date, days: number): Date => new Date(date.getTime() + days * DAY_MS);
const isoDate = (date: Date): string => date.toISOString().slice(0, 10);
const startOfDay = (date: Date): Date =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
const daysInMonth = (year: number, month: number): number =>
  new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

/** Pay-day style dates fall back to the previous Friday when they land on a weekend. */
function businessDay(year: number, month: number, day: number): number {
  const date = new Date(Date.UTC(year, month, Math.min(day, daysInMonth(year, month))));
  const dow = date.getUTCDay();
  if (dow === 6) return date.getUTCDate() - 1;
  if (dow === 0) return date.getUTCDate() - 2;
  return date.getUTCDate();
}

// ---------------------------------------------------------------------------------------------- IBANs

function mod97(numeric: string): number {
  let remainder = 0;
  for (const digit of numeric) remainder = (remainder * 10 + Number(digit)) % 97;
  return remainder;
}

export function makeIban(country: string, bban: string): string {
  const letters = (text: string): string =>
    [...text].map((c) => (c >= 'A' && c <= 'Z' ? String(c.charCodeAt(0) - 55) : c)).join('');
  const check = 98 - mod97(letters(`${bban}${country}00`));
  return `${country}${String(check).padStart(2, '0')}${bban}`;
}

// ---------------------------------------------------------------------------------------------- merchants

interface Spend {
  merchant: string;
  description: (rng: () => number) => string;
  min: number;
  max: number;
}

interface Fixed {
  day: number;
  amountMinor: number;
  merchant: string | null;
  description: string;
  category: 'DIRECT_DEBIT' | 'STANDING_ORDER' | 'PURCHASE';
  /** Zero-based months in which it recurs; every month when omitted. */
  months?: readonly number[];
  onCard?: boolean;
}

interface LocaleProfile {
  currency: 'EUR' | 'GBP';
  country: 'DE' | 'GB';
  salary: { day: number; amountMinor: number; description: string };
  savingsTransfer: { day: number; amountMinor: number };
  fixed: Fixed[];
  groceries: Spend[];
  dining: Spend[];
  transport: Spend[];
  shopping: Spend[];
  health: Spend[];
  entertainment: Spend[];
  travel: Spend[];
  cash: { merchant: string; description: string };
  pendingFallback: { merchant: string; description: string; amountMinor: number };
  hasCard: boolean;
  targets: Record<DatasetProfile, { current: number; savings: number }>;
}

const store = (name: string, city: string) => (rng: () => number) =>
  `${name} ${digits(rng, 4)} ${city}`;

const DE: LocaleProfile = {
  currency: 'EUR',
  country: 'DE',
  salary: { day: 28, amountMinor: 345_000, description: 'GEHALT ACME GMBH LOHN/GEHALT' },
  savingsTransfer: { day: 29, amountMinor: 30_000 },
  fixed: [
    {
      day: 1,
      amountMinor: -115_000,
      merchant: null,
      description: 'MIETE WOHNUNG HAUSVERWALTUNG MEIER',
      category: 'STANDING_ORDER',
    },
    {
      day: 2,
      amountMinor: -21_240,
      merchant: null,
      description: 'ALLIANZ HAFTPFLICHT BEITRAG',
      category: 'DIRECT_DEBIT',
      months: [0, 3, 6, 9],
    },
    {
      day: 3,
      amountMinor: -2_990,
      merchant: null,
      description: 'FITX FITNESSSTUDIO MITGLIEDSBEITRAG',
      category: 'DIRECT_DEBIT',
    },
    {
      day: 5,
      amountMinor: -7_800,
      merchant: null,
      description: 'STADTWERKE STROM ABSCHLAG',
      category: 'DIRECT_DEBIT',
    },
    {
      day: 5,
      amountMinor: -1_399,
      merchant: 'NETFLIX',
      description: 'NETFLIX.COM',
      category: 'PURCHASE',
      onCard: true,
    },
    {
      day: 8,
      amountMinor: -3_999,
      merchant: null,
      description: 'TELEKOM DEUTSCHLAND INTERNET',
      category: 'DIRECT_DEBIT',
    },
    {
      day: 12,
      amountMinor: -1_099,
      merchant: 'SPOTIFY',
      description: 'SPOTIFY AB STOCKHOLM',
      category: 'PURCHASE',
      onCard: true,
    },
    {
      day: 15,
      amountMinor: -2_499,
      merchant: null,
      description: 'VODAFONE MOBILFUNK RECHNUNG',
      category: 'DIRECT_DEBIT',
    },
    {
      day: 20,
      amountMinor: -299,
      merchant: 'APPLE',
      description: 'APPLE.COM/BILL ICLOUD',
      category: 'PURCHASE',
      onCard: true,
    },
  ],
  groceries: [
    { merchant: 'REWE', description: store('REWE SAGT DANKE.', 'BERLIN'), min: 650, max: 9_600 },
    { merchant: 'LIDL', description: store('LIDL SAGT DANKE', 'BERLIN'), min: 480, max: 7_400 },
    { merchant: 'EDEKA', description: store('EDEKA NEUKAUF', 'BERLIN'), min: 590, max: 8_800 },
    { merchant: 'ALDI', description: store('ALDI SUED', 'BERLIN'), min: 520, max: 6_900 },
    { merchant: 'DM', description: store('DM-DROGERIE MARKT', 'BERLIN'), min: 390, max: 3_800 },
  ],
  dining: [
    {
      merchant: 'CAFE EINSTEIN',
      description: store('CAFE EINSTEIN', 'BERLIN'),
      min: 380,
      max: 2_400,
    },
    {
      merchant: 'BURGERMEISTER',
      description: store('BURGERMEISTER', 'BERLIN'),
      min: 890,
      max: 3_200,
    },
    {
      merchant: 'LIEFERANDO',
      description: () => 'LIEFERANDO.DE BESTELLUNG',
      min: 1_490,
      max: 4_800,
    },
    { merchant: 'VAPIANO', description: store('VAPIANO', 'BERLIN'), min: 1_290, max: 3_900 },
    { merchant: 'STARBUCKS', description: store('STARBUCKS', 'BERLIN'), min: 390, max: 1_100 },
  ],
  transport: [
    { merchant: 'BVG', description: () => 'BVG FAHRAUSWEIS BERLIN', min: 290, max: 900 },
    {
      merchant: 'DEUTSCHE BAHN',
      description: () => 'DB VERTRIEB GMBH BAHN TICKET',
      min: 2_490,
      max: 5_990,
    },
    { merchant: 'SHELL', description: store('SHELL TANKSTELLE', 'BERLIN'), min: 3_800, max: 7_200 },
    { merchant: 'UBER', description: () => 'UBER *TRIP HELP.UBER.COM', min: 790, max: 2_800 },
  ],
  shopping: [
    { merchant: 'AMAZON', description: () => 'AMAZON EU SARL LUXEMBOURG', min: 999, max: 13_900 },
    { merchant: 'ZALANDO', description: () => 'ZALANDO SE BERLIN', min: 2_490, max: 11_900 },
    { merchant: 'IKEA', description: store('IKEA DEUTSCHLAND', 'BERLIN'), min: 1_290, max: 14_900 },
    { merchant: 'MEDIAMARKT', description: store('MEDIAMARKT', 'BERLIN'), min: 1_990, max: 12_900 },
  ],
  health: [
    {
      merchant: 'APOTHEKE',
      description: store('APOTHEKE AM MARKT', 'BERLIN'),
      min: 595,
      max: 4_500,
    },
    {
      merchant: 'ZAHNARZT',
      description: () => 'ZAHNARZTPRAXIS DR. BECKER',
      min: 2_500,
      max: 8_500,
    },
  ],
  entertainment: [
    { merchant: 'CINEMAXX', description: () => 'CINEMAXX KINO BERLIN', min: 950, max: 3_400 },
    {
      merchant: 'TICKETMASTER',
      description: () => 'TICKETMASTER DE EVENT',
      min: 3_900,
      max: 5_900,
    },
  ],
  travel: [
    { merchant: 'LUFTHANSA', description: () => 'DLH LUFTHANSA FLUG', min: 8_900, max: 32_000 },
    {
      merchant: 'BOOKING',
      description: () => 'BOOKING.COM HOTEL AMSTERDAM',
      min: 9_500,
      max: 42_000,
    },
    { merchant: 'AIRBNB', description: () => 'AIRBNB * HM4KQ2', min: 12_000, max: 38_000 },
  ],
  cash: { merchant: 'GELDAUTOMAT', description: 'GELDAUTOMAT SPARKASSE BARAUSZAHLUNG' },
  pendingFallback: {
    merchant: 'CAFE EINSTEIN',
    description: 'CAFE EINSTEIN 4471 BERLIN',
    amountMinor: -480,
  },
  hasCard: true,
  targets: {
    standard: { current: 284_013, savings: 841_560 },
    tight: { current: 14_207, savings: 3_500 },
  },
};

const GB: LocaleProfile = {
  currency: 'GBP',
  country: 'GB',
  salary: { day: 25, amountMinor: 285_000, description: 'SALARY ACME LTD BGC' },
  savingsTransfer: { day: 26, amountMinor: 25_000 },
  fixed: [
    {
      day: 1,
      amountMinor: -95_000,
      merchant: null,
      description: 'RENT FLAT 4 LETTINGS LTD',
      category: 'STANDING_ORDER',
    },
    {
      day: 1,
      amountMinor: -14_200,
      merchant: null,
      description: 'COUNCIL TAX LB HACKNEY',
      category: 'DIRECT_DEBIT',
    },
    {
      day: 3,
      amountMinor: -1_999,
      merchant: null,
      description: 'PUREGYM MEMBERSHIP',
      category: 'DIRECT_DEBIT',
    },
    {
      day: 8,
      amountMinor: -6_400,
      merchant: null,
      description: 'OCTOPUS ENERGY DD',
      category: 'DIRECT_DEBIT',
    },
    {
      day: 5,
      amountMinor: -1_099,
      merchant: 'NETFLIX',
      description: 'NETFLIX.COM',
      category: 'PURCHASE',
    },
    {
      day: 12,
      amountMinor: -2_800,
      merchant: null,
      description: 'THAMES WATER DD',
      category: 'DIRECT_DEBIT',
    },
    {
      day: 12,
      amountMinor: -1_199,
      merchant: 'SPOTIFY',
      description: 'SPOTIFY P1A2B3',
      category: 'PURCHASE',
    },
    {
      day: 15,
      amountMinor: -2_200,
      merchant: null,
      description: 'EE LIMITED MOBILE',
      category: 'DIRECT_DEBIT',
    },
  ],
  groceries: [
    { merchant: 'TESCO', description: store('TESCO STORES', 'LONDON'), min: 450, max: 8_200 },
    {
      merchant: 'SAINSBURYS',
      description: store('SAINSBURYS S/MKTS', 'LONDON'),
      min: 520,
      max: 7_600,
    },
    { merchant: 'ALDI', description: store('ALDI STORES', 'LONDON'), min: 480, max: 5_900 },
    { merchant: 'CO-OP', description: store('CO-OP FOOD', 'LONDON'), min: 290, max: 2_800 },
    { merchant: 'WAITROSE', description: store('WAITROSE', 'LONDON'), min: 890, max: 6_400 },
  ],
  dining: [
    {
      merchant: 'PRET A MANGER',
      description: store('PRET A MANGER', 'LONDON'),
      min: 350,
      max: 1_450,
    },
    { merchant: 'COSTA', description: store('COSTA COFFEE', 'LONDON'), min: 320, max: 980 },
    { merchant: 'WAGAMAMA', description: store('WAGAMAMA', 'LONDON'), min: 1_190, max: 3_400 },
    { merchant: 'DELIVEROO', description: () => 'DELIVEROO.CO.UK ORDER', min: 1_590, max: 4_200 },
    { merchant: 'GREGGS', description: store('GREGGS', 'LONDON'), min: 190, max: 780 },
  ],
  transport: [
    { merchant: 'TFL', description: () => 'TFL TRAVEL CH LONDON', min: 280, max: 1_950 },
    { merchant: 'TRAINLINE', description: () => 'TRAINLINE.COM LONDON', min: 1_850, max: 6_900 },
    { merchant: 'SHELL', description: store('SHELL', 'LONDON'), min: 3_500, max: 6_900 },
    { merchant: 'UBER', description: () => 'UBER *TRIP HELP.UBER.COM', min: 690, max: 2_600 },
  ],
  shopping: [
    { merchant: 'AMAZON', description: () => 'AMZNMKTPLACE AMAZON.CO.UK', min: 799, max: 11_900 },
    { merchant: 'ASOS', description: () => 'ASOS.COM LONDON', min: 1_800, max: 8_900 },
    { merchant: 'ARGOS', description: store('ARGOS', 'LONDON'), min: 1_200, max: 9_900 },
    { merchant: 'JOHN LEWIS', description: store('JOHN LEWIS', 'LONDON'), min: 2_500, max: 13_900 },
  ],
  health: [
    { merchant: 'BOOTS', description: store('BOOTS PHARMACY', 'LONDON'), min: 395, max: 3_200 },
    { merchant: 'DENTIST', description: () => 'SMILE DENTAL CARE', min: 2_300, max: 7_500 },
  ],
  entertainment: [
    { merchant: 'ODEON', description: () => 'ODEON CINEMAS LTD', min: 850, max: 2_800 },
    {
      merchant: 'TICKETMASTER',
      description: () => 'TICKETMASTER UK EVENT',
      min: 3_500,
      max: 6_500,
    },
  ],
  travel: [
    { merchant: 'EASYJET', description: () => 'EASYJET AIRLINE FLIGHT', min: 6_900, max: 24_000 },
    { merchant: 'AIRBNB', description: () => 'AIRBNB * HMXQ92', min: 11_000, max: 36_000 },
  ],
  cash: { merchant: 'ATM', description: 'CASH WITHDRAWAL ATM LONDON' },
  pendingFallback: {
    merchant: 'PRET A MANGER',
    description: 'PRET A MANGER 1187 LONDON',
    amountMinor: -395,
  },
  hasCard: false,
  targets: {
    standard: { current: 196_348, savings: 612_000 },
    tight: { current: 9_520, savings: 2_000 },
  },
};

const LOCALES = { de: DE, gb: GB } as const;

// ---------------------------------------------------------------------------------------------- builder

interface Draft extends Omit<MockTransaction, 'id' | 'timestamp'> {
  hour: number;
}

export function buildDataset(options: DatasetOptions): Dataset {
  const { seed, institution, profile, today: now } = options;
  const L: LocaleProfile = LOCALES[institution.locale];
  const scale = profile === 'tight' ? 0.7 : 1;
  const today = startOfDay(now);
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 12, 1));

  const accountId = (kind: string): string =>
    `acc_${hash32(`${seed}|${institution.slug}|${kind}`).toString(36)}`;
  const accounts: MockAccount[] = [];
  const bban = (kind: string): string =>
    String(hash32(`${seed}|${kind}`))
      .padStart(10, '0')
      .slice(0, 10);

  if (L.country === 'DE') {
    accounts.push(
      {
        id: accountId('current'),
        type: 'TRANSACTION',
        name: 'Girokonto',
        currency: 'EUR',
        iban: makeIban('DE', `37040044${bban('current')}`),
        sortCode: null,
        accountNumber: null,
        bic: 'MOCKDEB1XXX',
        headroomMinor: 50_000,
      },
      {
        id: accountId('savings'),
        type: 'SAVINGS',
        name: 'Tagesgeld',
        currency: 'EUR',
        iban: makeIban('DE', `37040044${bban('savings')}`),
        sortCode: null,
        accountNumber: null,
        bic: 'MOCKDEB1XXX',
        headroomMinor: 0,
      },
      {
        id: accountId('card'),
        type: 'CREDIT_CARD',
        name: 'Visa Gold',
        currency: 'EUR',
        iban: null,
        sortCode: null,
        accountNumber: `4929${bban('card').slice(0, 8)}`,
        bic: 'MOCKDEB1XXX',
        headroomMinor: 300_000,
      },
    );
  } else {
    const sortCode = '040004';
    accounts.push(
      {
        id: accountId('current'),
        type: 'TRANSACTION',
        name: 'Everyday Account',
        currency: 'GBP',
        iban: makeIban('GB', `MOCK${sortCode}${bban('current').slice(0, 8)}`),
        sortCode,
        accountNumber: bban('current').slice(0, 8),
        bic: 'MOCKGB2LXXX',
        headroomMinor: 50_000,
      },
      {
        id: accountId('savings'),
        type: 'SAVINGS',
        name: 'Easy Saver',
        currency: 'GBP',
        iban: makeIban('GB', `MOCK${sortCode}${bban('savings').slice(0, 8)}`),
        sortCode,
        accountNumber: bban('savings').slice(0, 8),
        bic: 'MOCKGB2LXXX',
        headroomMinor: 0,
      },
    );
  }

  const current = accounts[0];
  const savings = accounts[1];
  const card = L.hasCard ? accounts[2] : null;

  const drafts: Draft[] = [];
  const push = (account: MockAccount, draft: Omit<Draft, 'accountId' | 'currency'>): void => {
    drafts.push({ ...draft, accountId: account.id, currency: account.currency });
  };

  let cardOutstanding = 0;

  for (let day = new Date(start); day <= today; day = addDays(day, 1)) {
    const year = day.getUTCFullYear();
    const month = day.getUTCMonth();
    const dom = day.getUTCDate();
    const date = isoDate(day);
    const rng = rngFor(seed, date);

    // Salary and the standing order to savings.
    if (dom === businessDay(year, month, L.salary.day)) {
      const amount = Math.round(L.salary.amountMinor * (profile === 'tight' ? 0.61 : 1));
      push(current, {
        date,
        hour: 6,
        amountMinor: amount,
        description: L.salary.description,
        merchant: null,
        category: 'CREDIT',
        pending: false,
      });
    }
    if (dom === Math.min(L.savingsTransfer.day, daysInMonth(year, month))) {
      const amount = Math.round(L.savingsTransfer.amountMinor * (profile === 'tight' ? 0.12 : 1));
      push(current, {
        date,
        hour: 7,
        amountMinor: -amount,
        description: 'DAUERAUFTRAG UMBUCHUNG TAGESGELD / SAVINGS TRANSFER',
        merchant: null,
        category: 'STANDING_ORDER',
        pending: false,
      });
      push(savings, {
        date,
        hour: 7,
        amountMinor: amount,
        description: 'DAUERAUFTRAG VON GIROKONTO / TRANSFER FROM CURRENT',
        merchant: null,
        category: 'TRANSFER',
        pending: false,
      });
    }

    // Fixed monthly items.
    for (const item of L.fixed) {
      if (item.months && !item.months.includes(month)) continue;
      if (dom !== Math.min(item.day, daysInMonth(year, month))) continue;
      const rentScale =
        item.description.startsWith('MIETE') || item.description.startsWith('RENT')
          ? profile === 'tight'
            ? 0.68
            : 1
          : 1;
      const amountMinor = Math.round(item.amountMinor * rentScale);
      const target = item.onCard && card ? card : current;
      push(target, {
        date,
        hour: 6,
        amountMinor,
        description: item.description,
        merchant: item.merchant,
        category: item.category,
        pending: false,
      });
      if (target === card) cardOutstanding += -amountMinor;
    }

    // Quarterly interest on the savings account.
    if (dom === 1 && month % 3 === 0) {
      const interest = Math.round(profile === 'tight' ? 14 : 1_234 + between(rng, 0, 90));
      push(savings, {
        date,
        hour: 5,
        amountMinor: interest,
        description: 'ZINSEN / INTEREST PAID',
        merchant: null,
        category: 'INTEREST',
        pending: false,
      });
    }

    // Credit card settlement on the 10th.
    if (card && dom === 10 && cardOutstanding > 0) {
      push(card, {
        date,
        hour: 8,
        amountMinor: cardOutstanding,
        description: 'ZAHLUNGSEINGANG DANKE',
        merchant: null,
        category: 'TRANSFER',
        pending: false,
      });
      push(current, {
        date,
        hour: 8,
        amountMinor: -cardOutstanding,
        description: 'KREDITKARTENABRECHNUNG VISA GOLD',
        merchant: null,
        category: 'DIRECT_DEBIT',
        pending: false,
      });
      cardOutstanding = 0;
    }

    // Everyday spending.
    const weekend = day.getUTCDay() === 0 || day.getUTCDay() === 6;
    const spend = (items: readonly Spend[], useCard: boolean): void => {
      const item = pick(rng, items);
      const amount = Math.max(100, Math.round(between(rng, item.min, item.max) * scale));
      const target = useCard && card ? card : current;
      const description = item.description(rng);
      push(target, {
        date,
        hour: 8 + Math.floor(rng() * 12),
        amountMinor: -amount,
        description,
        merchant: item.merchant,
        category: 'PURCHASE',
        pending: false,
      });
      if (target === card) cardOutstanding += amount;
    };

    if (rng() < (weekend ? 0.3 : 0.45)) spend(L.groceries, false);
    if (rng() < (weekend ? 0.34 : 0.2)) spend(L.dining, rng() < 0.3);
    if (rng() < 0.14) spend(L.transport, false);
    if (rng() < 0.12) spend(L.shopping, rng() < 0.6);
    if (rng() < 0.035) spend(L.health, false);
    if (rng() < (weekend ? 0.07 : 0.03)) spend(L.entertainment, rng() < 0.5);
    if (profile === 'standard' && rng() < 0.007) spend(L.travel, true);

    if (rng() < 0.03) {
      const amount = pick(rng, [5_000, 10_000, 15_000]) * (profile === 'tight' ? 0.4 : 1);
      push(current, {
        date,
        hour: 12,
        amountMinor: -Math.round(amount),
        description: L.cash.description,
        merchant: L.cash.merchant,
        category: 'ATM',
        pending: false,
      });
    }
    if (rng() < 0.012) {
      const item = pick(rng, L.shopping);
      push(current, {
        date,
        hour: 10,
        amountMinor: between(rng, 999, 6_000),
        description: `ERSTATTUNG ${item.description(rng)}`,
        merchant: item.merchant,
        category: 'CREDIT',
        pending: false,
      });
    }
  }

  // Own transfers made through the payments flow (M3): they leave the current account when executed.
  for (const payment of options.executedPayments ?? []) {
    const executed = new Date(payment.executedAt);
    push(current, {
      date: isoDate(executed),
      hour: executed.getUTCHours(),
      amountMinor: -payment.amountMinor,
      description: `UEBERWEISUNG AN ${payment.beneficiaryName.toUpperCase()} ${payment.reference.toUpperCase()}`,
      merchant: null,
      category: 'DEBIT',
      pending: false,
    });
  }

  // Pending: the most recent card and debit activity has not booked yet. Guarantee at least one example.
  const todayIso = isoDate(today);
  const yesterdayIso = isoDate(addDays(today, -1));
  let anyPending = false;
  for (const draft of drafts) {
    const isFresh =
      draft.date === todayIso ||
      (draft.date === yesterdayIso &&
        hash32(`${seed}|${draft.description}|${draft.amountMinor}`) % 2 === 0);
    if (isFresh && draft.category === 'PURCHASE' && draft.amountMinor < 0) {
      draft.pending = true;
      anyPending = true;
    }
  }
  if (!anyPending) {
    drafts.push({
      accountId: current.id,
      currency: current.currency,
      date: todayIso,
      hour: 9,
      amountMinor: L.pendingFallback.amountMinor,
      description: L.pendingFallback.description,
      merchant: L.pendingFallback.merchant,
      category: 'PURCHASE',
      pending: true,
    });
  }

  // Chronological order, stable ids per account/day, then balances.
  drafts.sort((a, b) => (a.date === b.date ? a.hour - b.hour : a.date < b.date ? -1 : 1));
  const counters = new Map<string, number>();
  const transactions: MockTransaction[] = drafts.map((draft) => {
    const key = `${draft.accountId}|${draft.date}`;
    const n = (counters.get(key) ?? 0) + 1;
    counters.set(key, n);
    const { hour, ...rest } = draft;
    return {
      ...rest,
      id: draft.pending ? null : `${draft.accountId}-${draft.date.replaceAll('-', '')}-${n}`,
      timestamp: `${draft.date}T${String(hour).padStart(2, '0')}:${String(10 + ((n * 7) % 50)).padStart(2, '0')}:00.000Z`,
    };
  });

  const balances = new Map<string, MockBalance>();
  const target = L.targets[profile];
  for (const account of accounts) {
    const booked = transactions.filter((t) => t.accountId === account.id && !t.pending);
    const pending = transactions.filter((t) => t.accountId === account.id && t.pending);
    const bookedSum = booked.reduce((sum, t) => sum + t.amountMinor, 0);
    const pendingSum = pending.reduce((sum, t) => sum + t.amountMinor, 0);
    const targetMinor =
      account.type === 'TRANSACTION'
        ? target.current
        : account.type === 'SAVINGS'
          ? target.savings
          : null;
    // The opening balance is whatever makes today's balance land on the target (cards start from zero).
    const opening = targetMinor === null ? 0 : targetMinor - bookedSum;
    const currentMinor = opening + bookedSum;
    balances.set(account.id, {
      currentMinor,
      availableMinor: currentMinor + pendingSum + account.headroomMinor,
    });
  }

  return { accounts, transactions, balances };
}
