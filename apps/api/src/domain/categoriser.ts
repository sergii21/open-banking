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
    category: 'housing',
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
      'STADTWERKE|STROM|GAS|WASSER|ENERGIE|VATTENFALL|E\\.ON|EON|TELEKOM|VODAFONE|O2|CONGSTAR|1&1|HUK|ALLIANZ|VERSICHERUNG|INSURANCE|AXA|OCTOPUS|OCTOPUS ENERGY|BRITISH GAS|THAMES WATER|BT GROUP|VIRGIN MEDIA|SKY|EE LIMITED|GEZ|RUNDFUNK|BEITRAGSSERVICE|INTERNET|MOBILFUNK|ELECTRICITY|BROADBAND|HAFTPFLICHT',
    ),
  },
  {
    category: 'groceries',
    pattern: words(
      'REWE|LIDL|ALDI|EDEKA|PENNY|NETTO|KAUFLAND|DM-DROGERIE|DM DROGERIE|ROSSMANN|TESCO|SAINSBURYS?|ASDA|MORRISONS|WAITROSE|CO-OP|COOP|CARREFOUR|MERCADONA|SUPERMARKT|BIO COMPANY|DENNS|ALBERT HEIJN|SUPERMARKET|OCADO|WOCHENMARKT',
    ),
  },
  {
    category: 'dining',
    pattern: words(
      'RESTAURANT|CAFE|COFFEE|STARBUCKS|MCDONALDS?|BURGER|BURGERMEISTER|KFC|SUBWAY|DOMINOS?|PIZZA|LIEFERANDO|WOLT|UBER EATS|DELIVEROO|JUST EAT|BAECKEREI|BAKERY|PRET A MANGER|PRET|COSTA|NANDOS|WAGAMAMA|PUB|BAR|BISTRO|IMBISS|VAPIANO|GREGGS|ITSU|DOENER|KEBAP',
    ),
  },
  {
    category: 'transport',
    pattern: words(
      'DEUTSCHE BAHN|DB VERTRIEB|DB FERNVERKEHR|BVG|MVG|HVV|BAHN|TFL|TRANSPORT FOR LONDON|OYSTER|UBER|BOLT|FREENOW|SHELL|ARAL|ESSO|BP|TOTAL|JET TANKSTELLE|TANKSTELLE|PARKING|PARKEN|FLIXBUS|NATIONAL RAIL|TRAINLINE|LIME|NEXTBIKE|DEUTSCHLANDTICKET|PETROL',
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
      'APOTHEKE|PHARMACY|BOOTS|ARZT|DR|DOKTOR|ZAHNARZT|DENTIST|KLINIK|CLINIC|HOSPITAL|PHYSIO|PHYSIOTHERAPIE|OPTIKER|SPECSAVERS|KRANKENKASSE|AOK|BARMER|NHS|DOCMORRIS',
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
      'AMAZON|AMZN|ZALANDO|IKEA|MEDIAMARKT|SATURN|H&M|ZARA|DECATHLON|EBAY|PAYPAL|OTTO|ASOS|PRIMARK|ARGOS|JOHN LEWIS|CURRYS|APPLE STORE|CONRAD|OBI|BAUHAUS|HORNBACH|TCHIBO|DOUGLAS|NIKE|ADIDAS|SHEIN|ETSY|B&Q',
    ),
  },
];

export interface CategoriseInput {
  description: string;
  counterparty: string | null;
  /** Signed minor units. */
  amountMinor: number;
  /** Provider-supplied coarse type such as TRANSFER or PURCHASE, when there is one. */
  providerCategory?: string | null;
}

export function normaliseText(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
}

export function categorise(input: CategoriseInput): Category {
  const text = normaliseText(`${input.counterparty ?? ''} ${input.description}`);
  const incoming = input.amountMinor > 0;

  if (TRANSFER.test(text) || input.providerCategory?.toUpperCase() === 'TRANSFER')
    return 'transfers';
  if (incoming && INCOME.test(text)) return 'income';

  for (const rule of RULES) {
    if (rule.pattern.test(text)) return rule.category;
  }
  // Money in with no merchant we recognise is income; unknown spending stays uncategorised.
  return incoming ? 'income' : 'other';
}
