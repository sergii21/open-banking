/**
 * The ФОП (sole proprietor, single-tax group 3) report: income read from a person's own UKRSIB business statements, counted per
 * quarter, with the single tax and the military levy worked out from it. A tool for looking at the numbers: it files nothing,
 * and every rate and rule here is an assumption the person confirms with the tax office or an accountant.
 */

/** What a statement row is, as far as the report is concerned. Credits are money in, debits money out. */
export const FOP_KINDS = [
  'income', // money received from a client: counted
  'own-transfer', // between the person's own accounts: not income
  'currency-sale', // the hryvnias a sale of currency brought: the currency was counted when it arrived
  'bank', // money from the bank itself (a return, interest): not counted unless the person says so
  'tax-single', // single tax paid
  'tax-levy', // military levy paid
  'esv', // the single social contribution paid
  'other-out', // any other money out (commissions, transfers out)
] as const;
export type FopKind = (typeof FOP_KINDS)[number];

export const FOP_RATES = [5, 3] as const;
export type FopRate = (typeof FOP_RATES)[number];

/** The military levy on a group 3 sole proprietor's income, in percent. An assumption, shown as one. */
export const FOP_MILITARY_LEVY_PERCENT = 1;

/** Annual income limit of group 3, in hryvnias, by year (1,167 minimum wages of 1 January). Unknown years have no entry. */
export const FOP_INCOME_LIMIT_UAH: Readonly<Record<string, number>> = { '2026': 10_091_049 };

/** The minimum single social contribution per month in hryvnias, by year. */
export const FOP_ESV_MONTHLY_UAH_MINOR: Readonly<Record<string, number>> = { '2026': 190_234 };

/** One statement row the report shows: money in that may count as income, and the tax payments made. */
export interface FopRow {
  id: string;
  ts: number;
  /** Kyiv calendar day, YYYY-MM-DD. */
  day: string;
  /** The last four digits of the account and its currency. */
  account: string;
  currency: string;
  direction: 'in' | 'out';
  /** In the account's currency, never negative. */
  amountMinor: number;
  /** The same in hryvnias at the bank's rate (the National Bank's, on the day of the operation), or null when the file had none. */
  uahMinor: number | null;
  counterparty: string;
  purpose: string;
  kind: FopKind;
  /** Whether the row is part of the income the report adds up. */
  counted: boolean;
  /** True when the person decided it, against what the report would have guessed. */
  chosen: boolean;
  /** Why the row is or is not counted, in words. */
  reason: string;
}

export interface FopPeriod {
  /** 1 to 4. */
  quarter: number;
  from: string;
  to: string;
  /** Income in this quarter alone, in hryvnias. */
  incomeMinor: number;
  /** Income from 1 January to the end of this quarter: what a quarterly return states. */
  cumulativeMinor: number;
  /** Single tax and military levy for this quarter: the cumulative amount so far minus what earlier quarters came to. */
  singleTaxMinor: number;
  levyMinor: number;
  /** What the statements say was paid for this quarter ("за 1-й квартал 2026 року" in the purpose). */
  paidSingleTaxMinor: number;
  paidLevyMinor: number;
  /** Single social contribution paid on days of this quarter. */
  paidEsvMinor: number;
  /** The minimum contribution for the quarter's three months, or null when the year's minimum is not known. */
  esvMinimumMinor: number | null;
  rows: number;
}

export interface FopAccountCoverage {
  account: string;
  currency: string;
  from: string;
  to: string;
  rows: number;
}

export interface FopReport {
  year: string;
  /** Years that have rows, newest first. */
  years: string[];
  singleTaxPercent: FopRate;
  militaryLevyPercent: number;
  periods: FopPeriod[];
  yearIncomeMinor: number;
  yearSingleTaxMinor: number;
  yearLevyMinor: number;
  /** The annual limit and how much of it the year's income has used, or null when the year's limit is not known. */
  limit: { limitMinor: number; usedPercent: number } | null;
  /** Foreign-currency income of the year: the amount received and what it counted as in hryvnias. */
  currencies: { currency: string; amountMinor: number; uahMinor: number }[];
  rows: FopRow[];
  accounts: FopAccountCoverage[];
  /** Plain-words warnings: rows that could not be counted, payments with no quarter. */
  warnings: string[];
  hasData: boolean;
}

/** What reading one UKRSIB statement file did. Counts and the last four digits of accounts: no name, purpose or amount. */
export interface FopImportResult {
  period: { from: string; to: string };
  rows: { read: number; added: number; updated: number; skipped: number };
  accounts: FopAccountCoverage[];
  notes: string[];
}
