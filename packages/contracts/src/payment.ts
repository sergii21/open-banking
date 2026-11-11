import { minorToDecimalString, parseAmountToMinor } from './money';

/**
 * Payment details found in pasted text, and the National Bank of Ukraine payment link built from them (the QR standard of
 * Resolution No. 97 of 19.08.2025, format 003). The link carries the details to the person's own bank app, where they confirm
 * the payment: nothing here sends money or talks to a bank.
 *
 * The format was read from open-source implementations, not from the Resolution itself, and no bank app has scanned a code from
 * this file yet. docs/HANDOVER.md keeps that on the not-verified list.
 */
export interface PaymentDetails {
  /** The recipient's name as the bank should show it. */
  recipient: string;
  /** UA + 27 digits, no spaces. */
  iban: string;
  /** ЄДРПОУ (8 digits) or a person's tax number (10 digits). */
  code: string;
  /** Hryvnias in kopiykas, or null to let the person type the amount in the bank app. */
  amountMinor: number | null;
  purpose: string;
}

export type PaymentField = 'recipient' | 'iban' | 'code' | 'amount' | 'purpose';

export const NBU_LINK_BASE = 'https://qr.bank.gov.ua/';
export const PAYMENT_LIMITS = {
  recipient: 140,
  purpose: 420,
  amountMinor: 99_999_999_999,
} as const;
/** What a version 17 code holds at error correction M in byte mode: the largest code the standard allows. */
export const NBU_LINK_MAX_BYTES = 504;

/** The ISO 13616 check: letters become numbers, the first four characters go last, and the whole is 1 modulo 97. */
export function isValidUaIban(iban: string): boolean {
  if (!/^UA\d{27}$/.test(iban)) return false;
  const digits = `${iban.slice(4)}3010${iban.slice(2, 4)}`; // U is 30, A is 10
  let rest = 0;
  for (const digit of digits) rest = (rest * 10 + Number(digit)) % 97;
  return rest === 1;
}

const DASH = '[:\\-–—]';
const AMOUNT = '(\\d[\\d \\u00a0\\u202f]*(?:[.,]\\d{1,2})?)';
const IBAN = /UA(?:\s?\d){27}(?!\d)/gi;
const CODE_LABEL =
  /(?:ЄДРПОУ|ЕДРПОУ|EDRPOU|ІПН|ИНН|РНОКПП|код\s+(?:отримувача|одержувача|получателя)|ідентифікаційний\s+код|податковий\s+номер)[^\d\n]{0,20}(\d{8,10})(?!\d)/i;
const AMOUNT_LABEL = new RegExp(
  `(?:сума|сумма|до\\s+сплати|до\\s+оплати|всього|разом|amount|total)[^\\d\\n]{0,25}${AMOUNT}`,
  'i',
);
const AMOUNT_UNIT = new RegExp(`${AMOUNT}\\s*(?:грн|uah|₴|гривень|гривні|гривня)`, 'i');
const RECIPIENT_LABEL = new RegExp(
  `^(?:назва\\s+|найменування\\s+)?(?:отримувач[а-яіїє]*|одержувач[а-яіїє]*|получатель|recipient|beneficiary)\\s*${DASH}\\s*(.+)$`,
  'i',
);
const RECIPIENT_FORM = /^(?:ФОП|ТОВ|ТзОВ|ПП|ПрАТ|АТ|ГО|ОСББ|КП|ФГ|БО|БФ)\s+\S/;
const PURPOSE_LABEL = new RegExp(
  `^(?:призначення(?:\\s+платежу)?|назначение(?:\\s+платежа)?|purpose|коментар|comment)\\s*${DASH}\\s*(.+)$`,
  'i',
);

const clean = (value: string, max: number): string =>
  value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["«“](.*)["»”]$/, '$1')
    .slice(0, max);

/**
 * Reads an invoice, a bank's details block or a chat message. It only fills what it is sure of: the person sees every field and
 * corrects it before anything is made from it.
 */
export function parsePaymentText(text: string): PaymentDetails {
  const ibans = [...text.matchAll(IBAN)].map((m) => m[0].replace(/\s/g, '').toUpperCase());
  const iban = ibans.find(isValidUaIban) ?? ibans[0] ?? '';
  // An account number is 29 characters of digits: nothing below may read a code or an amount out of it.
  const rest = text.replace(IBAN, ' ');
  const lines = rest
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

  const code =
    CODE_LABEL.exec(rest)?.[1] ?? lines.find((line) => /^(?:\d{8}|\d{10})$/.test(line)) ?? '';

  const money = code ? rest.replace(code, ' ') : rest;
  const typed = (AMOUNT_LABEL.exec(money) ?? AMOUNT_UNIT.exec(money))?.[1] ?? '';
  const amountMinor = parseAmountToMinor(typed.replace(/\s/g, ''), 'UAH');

  let recipient = '';
  let purpose = '';
  for (const line of lines) {
    recipient ||= RECIPIENT_LABEL.exec(line)?.[1] ?? '';
    purpose ||= PURPOSE_LABEL.exec(line)?.[1] ?? '';
  }
  recipient ||= lines.find((line) => RECIPIENT_FORM.test(line)) ?? '';

  return {
    recipient: clean(recipient, PAYMENT_LIMITS.recipient),
    iban,
    code: code.length === 9 ? '' : code,
    amountMinor:
      amountMinor !== null && amountMinor <= PAYMENT_LIMITS.amountMinor ? amountMinor : null,
    purpose: clean(purpose, PAYMENT_LIMITS.purpose),
  };
}

/** What still stops a link from being made, by field, in words for the person. Empty when the details are complete. */
export function paymentProblems(details: PaymentDetails): Partial<Record<PaymentField, string>> {
  const problems: Partial<Record<PaymentField, string>> = {};
  if (details.recipient.trim() === '') problems.recipient = 'Who is being paid?';
  if (details.iban === '') problems.iban = 'The account number (IBAN) is missing.';
  else if (!/^UA\d{27}$/.test(details.iban)) {
    problems.iban = 'A Ukrainian IBAN is UA followed by 27 digits.';
  } else if (!isValidUaIban(details.iban)) {
    problems.iban = 'This IBAN has a mistake in it: its check digits do not match.';
  }
  if (!/^(?:\d{8}|\d{10})$/.test(details.code)) {
    problems.code = 'The recipient’s code is 8 digits (ЄДРПОУ) or 10 digits (tax number).';
  }
  if (details.purpose.trim() === '') problems.purpose = 'Say what the payment is for.';
  return problems;
}

function utf8(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const point = char.codePointAt(0) ?? 0;
    if (point < 0x80) bytes.push(point);
    else if (point < 0x800) bytes.push(0xc0 | (point >> 6), 0x80 | (point & 63));
    else if (point < 0x10000) {
      bytes.push(0xe0 | (point >> 12), 0x80 | ((point >> 6) & 63), 0x80 | (point & 63));
    } else {
      bytes.push(
        0xf0 | (point >> 18),
        0x80 | ((point >> 12) & 63),
        0x80 | ((point >> 6) & 63),
        0x80 | (point & 63),
      );
    }
  }
  return bytes;
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function base64Url(bytes: readonly number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    out += ALPHABET.charAt(a >> 2) + ALPHABET.charAt(((a & 3) << 4) | (b >> 4));
    if (i + 1 < bytes.length) out += ALPHABET.charAt(((b & 15) << 2) | (c >> 6));
    if (i + 2 < bytes.length) out += ALPHABET.charAt(c & 63);
  }
  return out;
}

/** A line feed separates the fields, so one inside a value would move every field after it. */
const oneLine = (value: string): string => value.replace(/\s+/g, ' ').trim();

/** The 17 fields of format 003, in order. The amount, when given, is the only thing the standard lets differ from the text. */
export function nbuPaymentFields(details: PaymentDetails): string[] {
  const amount =
    details.amountMinor === null ? '' : `UAH${minorToDecimalString(details.amountMinor, 'UAH')}`;
  return [
    'BCD', // 1 service mark
    '003', // 2 format version
    '1', // 3 encoding: UTF-8
    'UCT', // 4 function: a credit transfer
    '', // 5 the recipient's unique id (reserved)
    oneLine(details.recipient).slice(0, PAYMENT_LIMITS.recipient), // 6
    details.iban, // 7
    amount, // 8
    details.code, // 9
    'OTHR/OTHR', // 10 category and purpose codes: banks refuse an empty one
    '', // 11 reference
    oneLine(details.purpose).slice(0, PAYMENT_LIMITS.purpose), // 12
    '', // 13 display text
    '', // 14 which fields the payer may not change: left to the bank
    '', // 15 valid until
    '', // 16 created
    '', // 17 signature
  ];
}

export type NbuLink = { ok: true; link: string } | { ok: false; reason: 'incomplete' | 'too-long' };

/** The link a bank app opens, and the text of the QR code: the same thing. */
export function nbuPaymentLink(details: PaymentDetails): NbuLink {
  if (Object.keys(paymentProblems(details)).length > 0) return { ok: false, reason: 'incomplete' };
  const link = NBU_LINK_BASE + base64Url(utf8(nbuPaymentFields(details).join('\n')));
  return link.length > NBU_LINK_MAX_BYTES ? { ok: false, reason: 'too-long' } : { ok: true, link };
}

/** A card number and an amount found in pasted text. There is no payment link for a card: the person copies both into their bank app. */
export interface CardTransfer {
  /** 16 digits, no spaces, or '' when the text has none. */
  card: string;
  /** Hryvnias in kopiykas, or null when the text names no amount. */
  amountMinor: number | null;
}

/** The Luhn check every payment card number passes: it catches one wrong digit and most swapped neighbours. */
export function isValidCardNumber(card: string): boolean {
  if (!/^\d{16}$/.test(card)) return false;
  let sum = 0;
  for (let i = 0; i < 16; i += 1) {
    let digit = Number(card.charAt(i));
    if (i % 2 === 0) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** 1234 5678 9012 3456: how a card number is read aloud and compared. */
export const formatCardNumber = (card: string): string => card.replace(/(\d{4})(?=\d)/g, '$1 ');

const CARD = /(?<!\d)\d{4}(?:[ \u00a0-]?\d{4}){3}(?!\d)/g;
const BARE_AMOUNT =
  /(?<![\d.,])(?:\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)(?:[.,]\d{1,2})?(?![\d.,])/g;

/**
 * Reads a message like "4149 … 5678, 500 грн". A number that passes the card check wins over one that does not. The amount is
 * the one the text labels or gives a unit, or else the only other number in it: with two candidates it stays empty.
 */
export function parseCardText(text: string): CardTransfer {
  const rest = text.replace(IBAN, ' ');
  const cards = [...rest.matchAll(CARD)].map((m) => m[0].replace(/\D/g, ''));
  const card = cards.find(isValidCardNumber) ?? cards[0] ?? '';
  if (card === '') return { card, amountMinor: null };
  const money = rest.replace(CARD, ' ');
  let typed = (AMOUNT_LABEL.exec(money) ?? AMOUNT_UNIT.exec(money))?.[1] ?? '';
  if (typed === '') {
    const bare = [...money.matchAll(BARE_AMOUNT)];
    if (bare.length === 1) typed = bare[0]?.[0] ?? '';
  }
  const amountMinor = parseAmountToMinor(typed.replace(/\s/g, ''), 'UAH');
  return {
    card,
    amountMinor:
      amountMinor !== null && amountMinor > 0 && amountMinor <= PAYMENT_LIMITS.amountMinor
        ? amountMinor
        : null,
  };
}

export const PRIVAT24_TRANSFER_BASE = 'https://next.privat24.ua/money-transfer/form/';

/**
 * Privat24's website transfer form with the card and the amount filled in. PrivatBank does not document this address: its shape
 * was read from a page a search engine had indexed, and nobody has opened one made here yet (docs/HANDOVER.md). The person logs
 * in and confirms in Privat24; null when the card number does not pass its check.
 */
export function privat24CardLink(transfer: CardTransfer): string | null {
  if (!isValidCardNumber(transfer.card)) return null;
  const amount =
    transfer.amountMinor === null
      ? ''
      : `,"amount":${minorToDecimalString(transfer.amountMinor, 'UAH')},"currency":"UAH"`;
  const form = `{"form":{"receiver":{"source":"manual","number":"${transfer.card}"}${amount}}}`;
  // The indexed address leaves colons and commas as they are.
  return (
    PRIVAT24_TRANSFER_BASE + encodeURIComponent(form).replace(/%3A/g, ':').replace(/%2C/g, ',')
  );
}
