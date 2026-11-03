import { createHash } from 'node:crypto';
import { currencyExponent } from '@ledger-lens/contracts';
import type { Calendar } from './calendar';
import { decimalToMinor } from './decimal';

/**
 * Reads a statement exported from Privat24 (Excel or CSV) into transactions.
 *
 * The real export's layout has not been seen by the author: this is written from the layout described by people who have
 * (a title row such as "Виписка з Ваших карток за період …", then column titles such as Дата, Категорія, Картка, Опис
 * операції, Сума в валюті картки, Валюта картки, Сума в валюті транзакції, Валюта транзакції, Залишок на кінець періоду).
 * So nothing here depends on a column's position or on the title row being there: the header row is found by matching known
 * column names (Ukrainian, Russian and English), columns are used by name, and when the required ones are missing the file
 * is refused with the column titles it did have and none of its values.
 */

export class StatementError extends Error {
  override name = 'StatementError';
  constructor(
    message: string,
    /** Column titles seen in the file, for the message. Never a value. */
    readonly headers: readonly string[] = [],
  ) {
    super(message);
  }
}

export interface StatementRow {
  /** Stable across imports of overlapping periods: the same transaction gets the same id every time. */
  id: string;
  ts: number;
  day: string;
  amountMinor: number;
  currency: string;
  description: string;
  last4: string | null;
  balanceMinor: number | null;
}

export interface ParsedStatement {
  period: { from: string; to: string };
  rows: StatementRow[];
  /** Non-empty lines that were not transactions (totals, notes). */
  skipped: number;
  notes: string[];
  /** The column titles that were used and those that were not: titles only. */
  headers: { used: string[]; unused: string[] };
}

type Role =
  | 'date'
  | 'time'
  | 'category'
  | 'card'
  | 'description'
  | 'amount'
  | 'amountOther'
  | 'currency'
  | 'currencyOther'
  | 'balance'
  | 'balanceCurrency'
  | 'debit'
  | 'credit';

const normalise = (value: string): string =>
  value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[’'`´]/g, '')
    .replace(/[^a-zа-яіїєґ0-9]+/g, ' ')
    .trim();

/** Which part of a statement a column title names, and how sure that is (a more specific title beats a bare "Сума"). */
function roleOf(title: string): { role: Role; rank: number } | null {
  const h = normalise(title);
  if (!h) return null;
  if (/(валюта|currency).*(залишк|остат|balance)/.test(h))
    return { role: 'balanceCurrency', rank: 1 };
  if (/залишок|залишк|остаток|остатк|balance/.test(h)) return { role: 'balance', rank: 1 };
  if (/^(витрати|витрата|видатки|видаток|списання|списание|расход|расходы|дебет|debit)$/.test(h)) {
    return { role: 'debit', rank: 1 };
  }
  if (
    /^(надходження|зарахування|зачисление|поступление|поступления|приход|доход|кредит|credit)$/.test(
      h,
    )
  ) {
    return { role: 'credit', rank: 1 };
  }
  if (/(валюта|currency).*(транзакц|transaction|операц)/.test(h))
    return { role: 'currencyOther', rank: 1 };
  if (/^(валюта|currency)$/.test(h)) return { role: 'currency', rank: 1 };
  if (/(валюта|currency).*(картк|карти|карты|card|рахунк|счет|account)/.test(h)) {
    return { role: 'currency', rank: 2 };
  }
  if (/(сума|сумма|amount).*(транзакц|transaction|операц)/.test(h))
    return { role: 'amountOther', rank: 1 };
  if (/(сума|сумма|amount|sum).*(картк|карти|карты|card|рахунк|счет|account)/.test(h)) {
    return { role: 'amount', rank: 2 };
  }
  if (/^(сума|сумма|amount|sum)$/.test(h)) return { role: 'amount', rank: 1 };
  if (/опис|описание|призначення|назначение|деталі|детали|details|description|merchant/.test(h)) {
    return { role: 'description', rank: 1 };
  }
  if (/категор|category/.test(h)) return { role: 'category', rank: 1 };
  // \b only knows ASCII letters, so the end of a Cyrillic word is looked for by hand.
  if (/^(дата|date)(?=\s|$)|дата.*час|date.*time|дата.*операц/.test(h))
    return { role: 'date', rank: 1 };
  if (/^(час|время|time)$/.test(h)) return { role: 'time', rank: 1 };
  if (/картк|карта|карти|card|^pan$|номер рахунку|рахунок|счет|account/.test(h)) {
    return { role: 'card', rank: 1 };
  }
  return null;
}

/** A column title looks like a title, not like data: short, and neither a number nor a date. */
const looksLikeTitle = (text: string): boolean =>
  text.length > 0 &&
  text.length <= 48 &&
  !/^[-+−\d\s.,:/]+$/.test(text) &&
  !/\d{1,2}[./]\d{1,2}[./]\d{2,4}/.test(text);

const textOf = (cell: string | undefined): string => (cell ?? '').replace(/\s+/g, ' ').trim();

interface When {
  day: string;
  hour: number;
  minute: number;
  second: number;
}

function parseWhen(text: string, time?: string): When | null {
  const t = text.trim();
  let year: number;
  let month: number;
  let dom: number;
  let rest: RegExpExecArray | null;
  const dotted =
    /^(\d{1,2})[./](\d{1,2})[./](\d{4}|\d{2})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(t);
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(t);
  if (dotted) {
    rest = dotted;
    dom = Number(dotted[1]);
    month = Number(dotted[2]);
    year = Number(dotted[3]);
    if (dotted[3]?.length === 2) year += 2000;
  } else if (iso) {
    rest = iso;
    year = Number(iso[1]);
    month = Number(iso[2]);
    dom = Number(iso[3]);
  } else return null;
  if (month < 1 || month > 12 || dom < 1 || dom > 31) return null;
  const extra = rest[4] === undefined && time ? /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(time) : null;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return {
    day: `${year}-${pad(month)}-${pad(dom)}`,
    hour: Number(rest[4] ?? extra?.[1] ?? 0),
    minute: Number(rest[5] ?? extra?.[2] ?? 0),
    second: Number(rest[6] ?? extra?.[3] ?? 0),
  };
}

const CURRENCY_ALIASES: Record<string, string> = {
  '₴': 'UAH',
  ГРН: 'UAH',
  'ГРН.': 'UAH',
  '980': 'UAH',
  $: 'USD',
  '840': 'USD',
  '€': 'EUR',
  '978': 'EUR',
  '£': 'GBP',
  '826': 'GBP',
};

function parseCurrency(text: string): string | null {
  const t = text.trim().toUpperCase();
  if (CURRENCY_ALIASES[t]) return CURRENCY_ALIASES[t];
  return /^[A-Z]{3}$/.test(t) ? t : null;
}

/** An amount cell in whatever way it was written: "-250,00", "−1 234.50 UAH", "250". */
function parseAmount(text: string, currency: string): number | null {
  const cleaned = text.replace(/[^\d,.+\-−–\s\u00a0\u202f]/g, '');
  return decimalToMinor(cleaned, currencyExponent(currency));
}

const last4Of = (cell: string): string | null => {
  const digits = cell.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
};

const MAX_ROWS = 100_000;

export function parsePrivat24Statement(
  table: readonly (readonly string[])[],
  calendar: Calendar,
): ParsedStatement {
  // 1. The header row: the first row in the top of the file whose titles name a date, a description and an amount.
  let header = -1;
  let columns = new Map<Role, number>();
  let titlesSeen: string[] = [];
  let bestScore = -1;
  for (let i = 0; i < Math.min(table.length, 40); i += 1) {
    const cells = (table[i] ?? []).map(textOf);
    const found = new Map<Role, { column: number; rank: number }>();
    cells.forEach((cell, column) => {
      const match = roleOf(cell);
      if (!match) return;
      const have = found.get(match.role);
      if (!have || match.rank > have.rank) found.set(match.role, { column, rank: match.rank });
    });
    const roles = new Set(found.keys());
    const amountish = roles.has('amount') || (roles.has('debit') && roles.has('credit'));
    if (roles.has('date') && roles.has('description') && amountish) {
      header = i;
      columns = new Map([...found].map(([role, { column }]) => [role, column]));
      break;
    }
    const titles = cells.filter(looksLikeTitle);
    if (roles.size > bestScore && titles.length >= 2) {
      bestScore = roles.size;
      titlesSeen = titles;
    }
  }
  if (header < 0) {
    throw new StatementError(
      'That file is not a Privat24 statement Ledger Lens can read: it needs a date, a description and an amount column.',
      titlesSeen,
    );
  }

  const titles = (table[header] ?? []).map(textOf);
  const at = (row: readonly string[], role: Role): string | undefined => {
    const column = columns.get(role);
    return column === undefined ? undefined : textOf(row[column]);
  };

  // 2. The period the file says it covers, from any line above the header ("за період 01.09.2026 - 30.09.2026").
  let stated: { from: string; to: string } | null = null;
  for (let i = 0; i < header && !stated; i += 1) {
    const line = (table[i] ?? []).join(' ');
    const dates = [...line.matchAll(/\d{1,2}[./]\d{1,2}[./]\d{4}/g)]
      .map((m) => parseWhen(m[0])?.day)
      .filter((d): d is string => d !== undefined);
    if (dates.length >= 2) stated = { from: dates[0] ?? '', to: dates[1] ?? '' };
  }

  // 3. The rows.
  const notes: string[] = [];
  const hasCurrency = columns.has('currency');
  const debit = columns.get('debit');
  const credit = columns.get('credit');
  const separate = debit !== undefined && credit !== undefined && !columns.has('amount');
  let skipped = 0;
  const seen = new Map<string, number>();
  const rows: StatementRow[] = [];
  const balances = new Map<string, { ts: number; minor: number }>();

  for (let i = header + 1; i < table.length; i += 1) {
    const cells = table[i] ?? [];
    if (cells.every((cell) => textOf(cell) === '')) continue;
    if (rows.length >= MAX_ROWS)
      throw new StatementError(
        'That statement has more than 100 000 rows, which is not a card statement.',
        titles.filter(looksLikeTitle),
      );
    const when = parseWhen(at(cells, 'date') ?? '', at(cells, 'time'));
    if (!when) {
      skipped += 1;
      continue;
    }
    const currency = hasCurrency ? parseCurrency(at(cells, 'currency') ?? '') : 'UAH';
    if (!currency) {
      skipped += 1;
      continue;
    }
    let amountMinor: number | null;
    if (separate) {
      const out = parseAmount(textOf(cells[debit]), currency);
      const incoming = parseAmount(textOf(cells[credit]), currency);
      amountMinor =
        out === null && incoming === null ? null : Math.abs(incoming ?? 0) - Math.abs(out ?? 0);
    } else {
      amountMinor = parseAmount(at(cells, 'amount') ?? '', currency);
    }
    if (amountMinor === null) {
      skipped += 1;
      continue;
    }

    const description = textOf(at(cells, 'description')) || 'Transaction';
    const last4 = last4Of(at(cells, 'card') ?? '');
    const ts = calendar.toInstant(when.day, when.hour, when.minute, when.second);
    // The same card, moment, amount and text can happen twice (two identical rides); the nth one is told apart by its number.
    const key = [last4 ?? '', ts, amountMinor, currency, description.toLowerCase()].join('\u0001');
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    const id = createHash('sha256').update(`${key}\u0001${nth}`).digest('hex').slice(0, 24);

    const balanceText = at(cells, 'balance');
    let balanceMinor: number | null = null;
    if (balanceText) {
      const balanceCurrency = parseCurrency(at(cells, 'balanceCurrency') ?? '') ?? currency;
      balanceMinor = parseAmount(balanceText, balanceCurrency);
      const slot = `${last4 ?? ''}:${currency}`;
      const latest = balances.get(slot);
      if (balanceMinor !== null && (!latest || ts >= latest.ts))
        balances.set(slot, { ts, minor: balanceMinor });
    }
    rows.push({ id, ts, day: when.day, amountMinor, currency, description, last4, balanceMinor });
  }

  if (rows.length === 0) {
    throw new StatementError(
      'That file has the columns of a statement but no transactions in it.',
      titles.filter(looksLikeTitle),
    );
  }
  // Without a sign there is no telling money in from money out, and a wrong guess would turn every figure upside down.
  if (rows.length >= 5 && !separate && rows.every((r) => r.amountMinor >= 0)) {
    throw new StatementError(
      'Every amount in that file has the same sign, so money in cannot be told from money out. Spending should be negative.',
      titles.filter(looksLikeTitle),
    );
  }

  // Each row keeps the balance of its own card, as the latest row of that card says.
  const withBalance = rows.map((row) => {
    const latest = balances.get(`${row.last4 ?? ''}:${row.currency}`);
    return { ...row, balanceMinor: latest ? latest.minor : null };
  });

  const days = rows.map((r) => r.day).sort();
  const period = stated ?? { from: days[0] ?? '', to: days.at(-1) ?? '' };
  // A period the title states that the rows overrun (or one it states backwards) is replaced by what the rows say.
  const from = days[0] !== undefined && days[0] < period.from ? days[0] : period.from;
  const to =
    days.at(-1) !== undefined && (days.at(-1) ?? '') > period.to ? (days.at(-1) ?? '') : period.to;

  if (!hasCurrency)
    notes.push('The file has no currency column, so the amounts are taken as hryvnias.');
  if (skipped > 0) {
    notes.push(
      `${skipped} line${skipped === 1 ? ' was' : 's were'} not transactions (totals or notes) and ${skipped === 1 ? 'was' : 'were'} left out.`,
    );
  }

  const used = new Set(columns.values());
  return {
    period: { from: from > to ? to : from, to: from > to ? from : to },
    rows: withBalance,
    skipped,
    notes,
    headers: {
      used: titles.filter((_, column) => used.has(column) && textOf(titles[column]) !== ''),
      unused: titles.filter((title, column) => !used.has(column) && looksLikeTitle(title)),
    },
  };
}
