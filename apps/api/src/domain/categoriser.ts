import type { Category } from '@ledger-lens/contracts';

/**
 * Rule-based categoriser. Banks send free-text descriptions, so we match merchant keywords on the normalised
 * `counterparty + description`. Order matters: the first matching rule wins, which is why "UBER EATS" is tested as
 * dining before "UBER" is tested as transport. A user override (category_source = 'user') always beats these rules and
 * is never overwritten by a refresh.
 */

interface Rule {
  category: Category;
  pattern: RegExp;
}

const words = (alternatives: string): RegExp => new RegExp(`\\b(?:${alternatives})\\b`);

const TRANSFER = words(
  'DAUERAUFTRAG|UMBUCHUNG|EIGENE KONTEN|TAGESGELD|KREDITKARTENABRECHNUNG|CREDIT CARD PAYMENT|STANDING ORDER|SAVINGS TRANSFER|TRANSFER TO SAVINGS|TRANSFER FROM CURRENT|OWN ACCOUNT|BETWEEN ACCOUNTS|ECHTZEITUEBERWEISUNG AN SICH',
);

const INCOME = words(
  'GEHALT|LOHN|SALARY|PAYROLL|WAGES|ARBEITGEBER|BONUS|ZINSEN|INTEREST PAID|KINDERGELD|STEUERERSTATTUNG|HMRC|DIVIDEND|RENTE',
);

/** Ordered: first match wins. */
const RULES: Rule[] = [
  {
    category: 'bills',
    pattern: words(
      'MIETE|RENT|HAUSVERWALTUNG|LANDLORD|HYPOTHEK|MORTGAGE|NEBENKOSTEN|LETTINGS|ESTATE AGENT|COUNCIL TAX|WOHNUNG',
    ),
  },
  {
    category: 'subscriptions',
    pattern: new RegExp(
      '\\b(?:NETFLIX|SPOTIFY|DISNEY|PRIME VIDEO|AMAZON PRIME|YOUTUBE|ICLOUD|GOOGLE ONE|ADOBE|DROPBOX|FITX|MCFIT|FITNESS|AUDIBLE|DAZN|NOTION|CHATGPT|OPENAI|PATREON|SUBSCRIPTION|MEMBERSHIP|TIDAL|DEEZER|NOW TV|PUREGYM|THE GYM|GYM)\\b|APPLE\\.COM/BILL',
    ),
  },
  {
    category: 'bills',
    pattern: words(
      'KYIVSTAR|LIFECELL|DTEK|STADTWERKE|STROM|GAS|WASSER|ENERGIE|VATTENFALL|E\\.ON|EON|TELEKOM|VODAFONE|O2|CONGSTAR|1&1|HUK|ALLIANZ|VERSICHERUNG|INSURANCE|AXA|OCTOPUS|OCTOPUS ENERGY|BRITISH GAS|THAMES WATER|BT GROUP|VIRGIN MEDIA|SKY|EE LIMITED|GEZ|RUNDFUNK|BEITRAGSSERVICE|INTERNET|MOBILFUNK|ELECTRICITY|BROADBAND|HAFTPFLICHT',
    ),
  },
  {
    category: 'groceries',
    pattern: words(
      'SILPO|ATB|ATB-MARKET|NOVUS|AUCHAN|VARUS|FOZZY|REWE|LIDL|ALDI|EDEKA|PENNY|NETTO|KAUFLAND|DM-DROGERIE|DM DROGERIE|ROSSMANN|TESCO|SAINSBURYS?|ASDA|MORRISONS|WAITROSE|CO-OP|COOP|CARREFOUR|MERCADONA|SUPERMARKT|BIO COMPANY|DENNS|ALBERT HEIJN|SUPERMARKET|OCADO|WOCHENMARKT',
    ),
  },
  {
    category: 'dining',
    pattern: words(
      'GLOVO|BOLT FOOD|SUSHI|RESTAURANT|CAFE|COFFEE|STARBUCKS|MCDONALDS?|BURGER|BURGERMEISTER|KFC|SUBWAY|DOMINOS?|PIZZA|LIEFERANDO|WOLT|UBER EATS|DELIVEROO|JUST EAT|BAECKEREI|BAKERY|PRET A MANGER|PRET|COSTA|NANDOS|WAGAMAMA|PUB|BAR|BISTRO|IMBISS|VAPIANO|GREGGS|ITSU|DOENER|KEBAP',
    ),
  },
  {
    category: 'transport',
    pattern: words(
      'UKLON|UKRZALIZNYTSIA|OKKO|WOG|DEUTSCHE BAHN|DB VERTRIEB|DB FERNVERKEHR|BVG|MVG|HVV|BAHN|TFL|TRANSPORT FOR LONDON|OYSTER|UBER|BOLT|FREENOW|SHELL|ARAL|ESSO|BP|TOTAL|JET TANKSTELLE|TANKSTELLE|PARKING|PARKEN|FLIXBUS|NATIONAL RAIL|TRAINLINE|LIME|NEXTBIKE|DEUTSCHLANDTICKET|PETROL',
    ),
  },
  {
    category: 'entertainment',
    pattern: words(
      'KINO|CINEMA|CINEMAXX|CINEWORLD|ODEON|VUE|TICKETMASTER|EVENTIM|STEAM|PLAYSTATION|NINTENDO|XBOX|THEATER|THEATRE|MUSEUM|KONZERT|CONCERT|BOWLING|TWITCH|UBISOFT|EPIC GAMES',
    ),
  },
  {
    category: 'health',
    pattern: words(
      'APTEKA|PODOROZHNYK|APOTHEKE|PHARMACY|BOOTS|ARZT|DR|DOKTOR|ZAHNARZT|DENTIST|KLINIK|CLINIC|HOSPITAL|PHYSIO|PHYSIOTHERAPIE|OPTIKER|SPECSAVERS|KRANKENKASSE|AOK|BARMER|NHS|DOCMORRIS',
    ),
  },
  {
    category: 'travel',
    pattern: words(
      'LUFTHANSA|RYANAIR|EASYJET|BRITISH AIRWAYS|AIR FRANCE|KLM|EUROWINGS|BOOKING\\.COM|AIRBNB|HOTEL|HOSTEL|EXPEDIA|EUROSTAR|TRIVAGO|SIXT|HERTZ|AVIS|AIRPORT|FLUGHAFEN|TUI|BLABLACAR|SKYSCANNER|OMIO',
    ),
  },
  {
    category: 'shopping',
    pattern: words(
      'ROZETKA|EPICENTR|FOXTROT|NOVA POSHTA|AMAZON|AMZN|ZALANDO|IKEA|MEDIAMARKT|SATURN|H&M|ZARA|DECATHLON|EBAY|PAYPAL|OTTO|ASOS|PRIMARK|ARGOS|JOHN LEWIS|CURRYS|APPLE STORE|CONRAD|OBI|BAUHAUS|HORNBACH|TCHIBO|DOUGLAS|NIKE|ADIDAS|SHEIN|ETSY|B&Q',
    ),
  },
];

/**
 * Ukrainian text. `\b` only knows ASCII word characters, so Cyrillic needs explicit letter boundaries, and the patterns go
 * through the same normalisation as the text (which folds Й to И and Ї to І) or they would never match.
 */
const cyrillic = (alternatives: string): RegExp =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${normaliseText(alternatives)})(?![\\p{L}\\p{N}])`, 'u');

const UA_TRANSFER = cyrillic(
  'ПЕРЕКАЗ З БАНКИ|ПЕРЕКАЗ НА БАНКУ|ПОПОВНЕННЯ БАНКИ|З БАНКИ|НА БАНКУ|НА СВОЮ КАРТКУ|З ВЛАСНОЇ КАРТКИ|НА ВЛАСНУ КАРТКУ|СВОЯ КАРТКА|МІЖ СВОЇМИ РАХУНКАМИ',
);
/** `[А-ЯІЇЄҐ]*` stands for the rest of a Ukrainian word: salary is "заробітна плата" but also "заробітної плати". */
const L = '[А-ЯІЇЄҐ]*';
const UA_INCOME = cyrillic(
  `ЗАРПЛАТ${L}|ЗАРОБІТН${L} ПЛАТ${L}|АВАНС${L}|ПРЕМІ${L}|КЕШБЕК|ДИВІДЕНД${L}|ПЕНСІ${L}|ДОПОМОГ${L}|ВИПЛАТА ВІД|ЄПІДТРИМКА|ЄВІДНОВЛЕННЯ|ВІДШКОДУВАНН${L}|ПОВЕРНЕННЯ КОШТІВ`,
);

/** "Оренда" in a transfer's comment says what the money is for, which beats the transfer category code. */
const RENT = cyrillic(`ОРЕНД${L}|КВАРТПЛАТ${L}|RENT`);

const UA_RULES: Rule[] = [
  { category: 'bills', pattern: cyrillic(`ОРЕНД${L}|КВАРТПЛАТ${L}|ІПОТЕК${L}`) },
  { category: 'subscriptions', pattern: cyrillic('ПІДПИСКА|ПЕРЕДПЛАТА') },
  {
    category: 'bills',
    pattern: cyrillic(
      'КИЇВСТАР|ЛАЙФСЕЛ|ВОДАФОН|ДТЕК|НАФТОГАЗ|ОСББ|ВОДОКАНАЛ|КОМУНАЛЬНІ ПОСЛУГИ|КОМУНАЛЬНІ|ІНТЕРНЕТ|ТЕЛЕКОМ|ЕЛЕКТРОЕНЕРГІЯ|ОПАЛЕННЯ|ГАЗ|СВІТЛО|ВОДА',
    ),
  },
  {
    category: 'groceries',
    pattern: cyrillic(
      'СІЛЬПО|АТБ|ФОРА|НОВУС|АШАН|ВАРУС|ЕКО МАРКЕТ|ФОЗЗІ|БРУСНИЧКА|СУПЕРМАРКЕТ|МІНІМАРКЕТ|ПРОДУКТИ|ПРОДУКТОВИЙ',
    ),
  },
  {
    category: 'dining',
    pattern: cyrillic(
      'КАВА|КАФЕ|РЕСТОРАН|ПІЦА|СУШІ|БУРГЕР|ПЕКАРНЯ|ЇДАЛЬНЯ|КОФЕЙНЯ|ШАУРМА|ГЛОВО|ГЛОВО',
    ),
  },
  {
    category: 'transport',
    pattern: cyrillic(
      'УКЛОН|УКРЗАЛІЗНИЦЯ|МЕТРОПОЛІТЕН|МЕТРО|ТАКСІ|АЗС|ЗАПРАВКА|ОККО|ПАРКУВАННЯ|ПРОЇЗД|АВТОВОКЗАЛ',
    ),
  },
  {
    category: 'health',
    pattern: cyrillic('АПТЕКА|КЛІНІКА|ЛІКАР|СТОМАТОЛОГ|ЛІКАРНЯ|МЕДИЧНИЙ|ПОДОРОЖНИК'),
  },
  { category: 'travel', pattern: cyrillic('АВІАКВИТКИ|ГОТЕЛЬ|АЕРОПОРТ|ХОСТЕЛ') },
  { category: 'entertainment', pattern: cyrillic('КІНО|КІНОТЕАТР|ТЕАТР|КОНЦЕРТ|МУЗЕЙ|КВИТКИ НА') },
  {
    category: 'shopping',
    pattern: cyrillic('РОЗЕТКА|ЕПІЦЕНТР|АЛЛО|СІТРУС|ФОКСТРОТ|КОМФІ|НОВА ПОШТА|ЗАРА|ІКЕА|МАГАЗИН'),
  },
];

/**
 * Merchant category codes (ISO 18245) that card networks attach to every purchase. When the bank reports one it is a
 * better signal than keywords, and it works for merchants whose names we have never seen. First matching range wins.
 */
const MCC_RANGES: readonly (readonly [number, number, Category])[] = [
  [5411, 5411, 'groceries'],
  [5422, 5422, 'groceries'],
  [5441, 5441, 'groceries'],
  [5451, 5451, 'groceries'],
  [5499, 5499, 'groceries'],
  [5300, 5300, 'groceries'],
  [5462, 5462, 'dining'],
  [5811, 5814, 'dining'],
  [3000, 3299, 'travel'],
  [3500, 3999, 'travel'],
  [4411, 4411, 'travel'],
  [4511, 4511, 'travel'],
  [4722, 4722, 'travel'],
  [7011, 7011, 'travel'],
  [7512, 7512, 'travel'],
  [4011, 4011, 'transport'],
  [4111, 4112, 'transport'],
  [4121, 4131, 'transport'],
  [4784, 4789, 'transport'],
  [5532, 5533, 'transport'],
  [5541, 5542, 'transport'],
  [7523, 7523, 'transport'],
  [4900, 4900, 'bills'],
  [4812, 4814, 'bills'],
  [4821, 4821, 'bills'],
  [6300, 6399, 'bills'],
  [9311, 9399, 'bills'],
  [4899, 4899, 'subscriptions'],
  [5815, 5818, 'subscriptions'],
  [5968, 5968, 'subscriptions'],
  [7997, 7997, 'subscriptions'],
  [5733, 5735, 'entertainment'],
  [7832, 7841, 'entertainment'],
  [7911, 7933, 'entertainment'],
  [7991, 7996, 'entertainment'],
  [7998, 7999, 'entertainment'],
  [5047, 5047, 'health'],
  [5122, 5122, 'health'],
  [5912, 5912, 'health'],
  [8011, 8099, 'health'],
  [1520, 1799, 'bills'],
  [6513, 6513, 'bills'],
  [4829, 4829, 'transfers'],
  [6051, 6051, 'transfers'],
  [6540, 6540, 'transfers'],
  [5200, 5399, 'shopping'],
  [5611, 5699, 'shopping'],
  [5712, 5722, 'shopping'],
  [5731, 5732, 'shopping'],
  [5941, 5949, 'shopping'],
  [5964, 5967, 'shopping'],
  [5969, 5999, 'shopping'],
  [6010, 6012, 'transfers'],
];

export function categoryForMcc(mcc: number): Category | null {
  for (const [low, high, category] of MCC_RANGES) {
    if (mcc >= low && mcc <= high) return category;
  }
  return null;
}

export interface CategoriseInput {
  description: string;
  counterparty: string | null;
  /** The note the person typed on a transfer. It often says more than the description does. */
  comment?: string | null;
  /** Signed minor units. */
  amountMinor: number;
  /** Merchant category code (ISO 18245) when the bank reports one. */
  mcc?: number | null;
  /** FOP (sole proprietor) accounts: money in from a named payer is income, not a transfer. */
  fop?: boolean;
}

export function normaliseText(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
}

export function categorise(input: CategoriseInput): Category {
  const text = normaliseText(
    `${input.counterparty ?? ''} ${input.description} ${input.comment ?? ''}`,
  );
  const incoming = input.amountMinor > 0;

  if (TRANSFER.test(text) || UA_TRANSFER.test(text)) return 'transfers';
  if (incoming && (INCOME.test(text) || UA_INCOME.test(text))) return 'income';
  if (incoming && input.fop && input.counterparty) return 'income';
  if (!incoming && RENT.test(text)) return 'bills';

  const byMcc = input.mcc ? categoryForMcc(input.mcc) : null;
  if (byMcc) return byMcc;

  for (const rule of RULES) {
    if (rule.pattern.test(text)) return rule.category;
  }
  for (const rule of UA_RULES) {
    if (rule.pattern.test(text)) return rule.category;
  }
  // Money in with no merchant we recognise is income; unknown spending stays uncategorised.
  return incoming ? 'income' : 'other';
}
