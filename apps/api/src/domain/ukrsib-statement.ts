import { createHash } from 'node:crypto';
import type { FopKind } from '@ledger-lens/contracts';
import type { Calendar } from './calendar';
import {
  looksLikeTitle,
  parseAmount,
  parseCurrency,
  parseWhen,
  StatementError,
  textOf,
} from './privat24-statement';

/**
 * Reads a statement CSV exported from UKRSIB business (Рахунки та виписки, Виписки, CSV): Windows-1251 text with `;` between
 * the cells and 17 titled columns. Debit and credit are separate columns, the account is the person's own, and "Гривневе
 * покриття" holds the hryvnia equivalent of a foreign-currency row (the National Bank's rate of the day of the operation: checked
 * on nine real receipts). Columns are found by their titles, never by position, and a file without the ones needed is refused
 * with the titles it had and none of its values.
 */

export interface UkrsibRow {
  /** Stable across imports of overlapping periods. */
  id: string;
  ts: number;
  day: string;
  /** The last four digits of the person's own account. */
  account: string;
  currency: string;
  direction: 'in' | 'out';
  amountMinor: number;
  uahMinor: number | null;
  counterparty: string;
  purpose: string;
  kind: FopKind;
}

export interface ParsedUkrsib {
  period: { from: string; to: string };
  rows: UkrsibRow[];
  skipped: number;
  notes: string[];
}

type Role =
  | 'date'
  | 'account'
  | 'currency'
  | 'debit'
  | 'credit'
  | 'counterparty'
  | 'purpose'
  | 'coverage'
  | 'document';

/** UKRSIB writes "операцiї" with a Latin i, so a Latin i is read as the Ukrainian letter before titles are compared. */
const normalise = (value: string): string =>
  value
    .toLowerCase()
    .replace(/i/g, 'і')
    .replace(/[^а-яіїєґ0-9a-z]+/g, ' ')
    .trim();

const TITLES: Readonly<Record<string, Role>> = {
  'дата операції': 'date',
  рахунок: 'account',
  валюта: 'currency',
  дебет: 'debit',
  кредит: 'credit',
  кореспондент: 'counterparty',
  'призначення платежу': 'purpose',
  'гривневе покриття': 'coverage',
  'номер документа': 'document',
};
const REQUIRED: readonly Role[] = ['date', 'account', 'currency', 'debit', 'credit', 'purpose'];

const OWN_TRANSFER = /між\s+власними\s+рахунками/i;
const CURRENCY_SALE = /гр\.?\s*[еэ]кв\.?\s*продаж/i;
const FROM_BANK = /укрсиббанк|ukrsibbank/i;
const LEVY = /військов[а-яіїєґ]*\s+збор/i;
const SINGLE_TAX = /єдин[а-яіїєґ]*\s+податк|(?:^|[^а-яіїєґ])єп(?:[^а-яіїєґ]|$)/i;
const ESV = /єдин[а-яіїєґ]*\s+внес[а-яіїєґ]*|(?:^|[^а-яіїєґ])єсв(?:[^а-яіїєґ]|$)/i;

/** What a row is, from its side and its words. Nothing here looks at an amount, a name or a number. */
export function classifyUkrsib(
  direction: 'in' | 'out',
  purpose: string,
  counterparty: string,
): FopKind {
  if (OWN_TRANSFER.test(purpose)) return 'own-transfer';
  if (direction === 'in') {
    if (CURRENCY_SALE.test(purpose)) return 'currency-sale';
    if (FROM_BANK.test(counterparty)) return 'bank';
    return 'income';
  }
  if (LEVY.test(purpose)) return 'tax-levy';
  if (SINGLE_TAX.test(purpose)) return 'tax-single';
  if (ESV.test(purpose)) return 'esv';
  return 'other-out';
}

const MAX_ROWS = 100_000;

export function parseUkrsibStatement(
  table: readonly (readonly string[])[],
  calendar: Calendar,
): ParsedUkrsib {
  let header = -1;
  let columns = new Map<Role, number>();
  let titlesSeen: string[] = [];
  for (let i = 0; i < Math.min(table.length, 20); i += 1) {
    const cells = (table[i] ?? []).map(textOf);
    const found = new Map<Role, number>();
    cells.forEach((cell, column) => {
      const role = TITLES[normalise(cell)];
      if (role && !found.has(role)) found.set(role, column);
    });
    if (REQUIRED.every((role) => found.has(role))) {
      header = i;
      columns = found;
      break;
    }
    const titles = cells.filter(looksLikeTitle);
    if (titles.length > titlesSeen.length) titlesSeen = titles;
  }
  if (header < 0) {
    throw new StatementError(
      'That file is not a UKRSIB business statement Ledger Lens can read: it needs the columns Дата операції, Рахунок, Валюта, Дебет, Кредит and Призначення платежу.',
      titlesSeen,
    );
  }
  const titles = (table[header] ?? []).map(textOf);
  const at = (row: readonly string[], role: Role): string => {
    const column = columns.get(role);
    return column === undefined ? '' : textOf(row[column]);
  };

  const rows: UkrsibRow[] = [];
  const seen = new Map<string, number>();
  const notes: string[] = [];
  let skipped = 0;
  for (let i = header + 1; i < table.length; i += 1) {
    const cells = table[i] ?? [];
    if (cells.every((cell) => textOf(cell) === '')) continue;
    if (rows.length >= MAX_ROWS) {
      throw new StatementError(
        'That statement has more than 100 000 rows, which is not a business statement.',
        titles.filter(looksLikeTitle),
      );
    }
    const when = parseWhen(at(cells, 'date'));
    const currency = parseCurrency(at(cells, 'currency'));
    const digits = at(cells, 'account').replace(/\D/g, '');
    if (!when || !currency || digits.length < 4) {
      skipped += 1;
      continue;
    }
    const out = parseAmount(at(cells, 'debit'), currency) ?? 0;
    const incoming = parseAmount(at(cells, 'credit'), currency) ?? 0;
    // One side or the other: a row with both (or neither) cannot be told apart safely, so it is left out and counted.
    if (out > 0 === incoming > 0) {
      skipped += 1;
      continue;
    }
    const direction = incoming > 0 ? 'in' : 'out';
    const amountMinor = direction === 'in' ? incoming : out;
    const covered = currency === 'UAH' ? null : parseAmount(at(cells, 'coverage'), 'UAH');
    const uahMinor =
      currency === 'UAH' ? amountMinor : covered !== null && covered > 0 ? covered : null;
    const purpose = at(cells, 'purpose');
    const counterparty = at(cells, 'counterparty');
    const ts = calendar.toInstant(when.day, when.hour, when.minute, when.second);
    const key = [
      digits,
      currency,
      ts,
      direction,
      amountMinor,
      at(cells, 'document'),
      purpose.toLowerCase(),
    ].join('\u0001');
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    rows.push({
      id: createHash('sha256').update(`${key}\u0001${nth}`).digest('hex').slice(0, 24),
      ts,
      day: when.day,
      account: digits.slice(-4),
      currency,
      direction,
      amountMinor,
      uahMinor,
      counterparty,
      purpose,
      kind: classifyUkrsib(direction, purpose, counterparty),
    });
  }
  if (rows.length === 0) {
    throw new StatementError(
      'That file has the columns of a business statement but no transactions in it.',
      titles.filter(looksLikeTitle),
    );
  }
  if (!columns.has('coverage') && rows.some((r) => r.currency !== 'UAH')) {
    notes.push(
      'The file has no "Гривневе покриття" column, so foreign-currency receipts have no hryvnia amount and are not counted.',
    );
  }
  if (skipped > 0) {
    notes.push(
      `${skipped} line${skipped === 1 ? ' was' : 's were'} not transactions (or had no single debit or credit) and ${skipped === 1 ? 'was' : 'were'} left out.`,
    );
  }
  const days = rows.map((r) => r.day).sort();
  return { period: { from: days[0] ?? '', to: days.at(-1) ?? '' }, rows, skipped, notes };
}
