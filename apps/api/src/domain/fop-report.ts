import {
  FOP_ESV_MONTHLY_UAH_MINOR,
  FOP_INCOME_LIMIT_UAH,
  FOP_MILITARY_LEVY_PERCENT,
  FOP_PERIOD_NAMES,
  type FopAccountCoverage,
  type FopKind,
  type FopLine,
  type FopPeriod,
  type FopRate,
  type FopReport,
  type FopRow,
} from '@ledger-lens/contracts';

/** A stored statement row, with the person's own decision about it (null: none, the report decides). */
export interface FopRecord {
  id: string;
  ts: number;
  day: string;
  account: string;
  currency: string;
  direction: 'in' | 'out';
  amountMinor: number;
  uahMinor: number | null;
  counterparty: string;
  purpose: string;
  kind: FopKind;
  override: boolean | null;
}

const QUARTER_TEXT = /за\s+(\d)\s*-?\s*(?:й|ий|го)?\s*квартал\s+(\d{4})/i;

const REASONS: Record<FopKind, string> = {
  income: 'Money received from a client',
  'own-transfer': 'Between your own accounts',
  'currency-sale': 'Hryvnias from selling currency: the currency was counted when it arrived',
  bank: 'Money from the bank itself, not a client',
  'tax-single': 'Single tax paid',
  'tax-levy': 'Military levy paid',
  esv: 'Single social contribution paid',
  'other-out': 'Money out',
};

/** Whole hryvnias-and-kopiykas share of an amount, in integer arithmetic: percent of minor units, rounded half up. */
export const percentOf = (minor: number, percent: number): number =>
  Math.floor((minor * percent + 50) / 100);

const quarterOf = (day: string): number => Math.floor((Number(day.slice(5, 7)) - 1) / 3) + 1;

function quarterRange(year: string, quarter: number): { from: string; to: string } {
  const startMonth = (quarter - 1) * 3 + 1;
  const endMonth = startMonth + 2;
  const endDay = new Date(Date.UTC(Number(year), endMonth, 0)).getUTCDate();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return {
    from: `${year}-${pad(startMonth)}-01`,
    to: `${year}-${pad(endMonth)}-${pad(endDay)}`,
  };
}

function judge(record: FopRecord): Pick<FopRow, 'counted' | 'chosen' | 'reason'> {
  if (record.direction === 'out') {
    return { counted: false, chosen: false, reason: REASONS[record.kind] };
  }
  const hasUah = record.uahMinor !== null;
  const guessed = record.kind === 'income' && hasUah;
  if (record.override === null) {
    return {
      counted: guessed,
      chosen: false,
      reason:
        record.kind === 'income' && !hasUah
          ? 'No hryvnia amount in the file, so it cannot be counted'
          : REASONS[record.kind],
    };
  }
  if (record.override && !hasUah) {
    return {
      counted: false,
      chosen: true,
      reason: 'You chose to count it, but the file has no hryvnia amount for it',
    };
  }
  return {
    counted: record.override,
    chosen: record.override !== guessed,
    reason: record.override ? 'You chose to count it' : 'You chose not to count it',
  };
}

/**
 * The lines of form F0103309 (order No. 578 as amended by No. 57 of 31.01.2025) a group 3 payer fills, cumulative from 1 January.
 * The line numbers and formulas were read from a filed declaration: 13 and 24 are lines 12 and 23 of the declaration before.
 */
export function declarationLines(
  rate: FopRate,
  cumulativeMinor: number,
  tax: number,
  previousTax: number,
  levy: number,
  previousLevy: number,
): FopLine[] {
  return [
    {
      code: rate === 5 ? '06' : '05',
      label: `Income taxed at ${rate} %`,
      amountMinor: cumulativeMinor,
    },
    { code: '08', label: 'Total income', amountMinor: cumulativeMinor },
    {
      code: rate === 5 ? '11' : '10',
      label: `Tax at ${rate} % (line ${rate === 5 ? '06' : '05'} × ${rate} %)`,
      amountMinor: tax,
    },
    { code: '12', label: 'Tax for the period (lines 9 + 10 + 11)', amountMinor: tax },
    {
      code: '13',
      label: 'Tax of the period before (line 12 of the declaration before)',
      amountMinor: previousTax,
    },
    {
      code: '14.1',
      label: 'Single tax to pay (line 12 − line 13)',
      amountMinor: tax - previousTax,
    },
    { code: '14', label: 'Single tax to pay in all (14.1 + 14.2)', amountMinor: tax - previousTax },
    {
      code: '23',
      label: `Military levy at ${FOP_MILITARY_LEVY_PERCENT} % (lines 5 + 6 + 7)`,
      amountMinor: levy,
    },
    {
      code: '24',
      label: 'Levy of the period before (line 23 of the declaration before)',
      amountMinor: previousLevy,
    },
    {
      code: '25',
      label: 'Military levy to pay (line 23 − line 24)',
      amountMinor: levy - previousLevy,
    },
  ];
}

export interface FopReportOptions {
  year: string | undefined;
  singleTaxPercent: FopRate;
  /** Kyiv calendar day of now, YYYY-MM-DD. */
  today: string;
}

export function buildFopReport(
  records: readonly FopRecord[],
  options: FopReportOptions,
): FopReport {
  const years = [...new Set(records.map((r) => r.day.slice(0, 4)))].sort().reverse();
  const thisYear = options.today.slice(0, 4);
  const year = options.year ?? (years.includes(thisYear) ? thisYear : (years[0] ?? thisYear));
  const inYear = records.filter((r) => r.day.startsWith(year));
  const judged = inYear.map((record) => ({ record, ...judge(record) }));

  const warnings: string[] = [];
  const counted = judged.filter((j) => j.counted);

  // Quarters are shown up to the one the latest data or today falls in.
  const lastDay = [options.today, ...inYear.map((r) => r.day)]
    .filter((d) => d.startsWith(year))
    .sort()
    .at(-1);
  const quarters = year > thisYear || lastDay === undefined ? 0 : quarterOf(lastDay);

  const paid = new Map<string, number>();
  let unplaced = 0;
  for (const { record } of judged) {
    if (record.direction !== 'out' || (record.kind !== 'tax-single' && record.kind !== 'tax-levy'))
      continue;
    const said = QUARTER_TEXT.exec(record.purpose);
    // A payment is for the quarter its words say, which may be in another year than the day it was paid.
    if (!said) unplaced += 1;
    else if (said[2] === year) {
      const key = `${record.kind}:${said[1]}`;
      paid.set(key, (paid.get(key) ?? 0) + record.amountMinor);
    }
  }
  // Payments made in another year for this year's quarters (the fourth is paid in January) are in that year's rows.
  for (const record of records) {
    if (record.day.startsWith(year) || record.direction !== 'out') continue;
    if (record.kind !== 'tax-single' && record.kind !== 'tax-levy') continue;
    const said = QUARTER_TEXT.exec(record.purpose);
    if (said?.[2] === year) {
      const key = `${record.kind}:${said[1]}`;
      paid.set(key, (paid.get(key) ?? 0) + record.amountMinor);
    }
  }
  if (unplaced > 0) {
    warnings.push(
      `${unplaced} tax payment${unplaced === 1 ? ' has' : 's have'} no quarter in its purpose, so ${unplaced === 1 ? 'it is' : 'they are'} not set against a quarter.`,
    );
  }
  const noUah = judged.filter(
    (j) => j.record.direction === 'in' && j.record.kind === 'income' && j.record.uahMinor === null,
  ).length;
  if (noUah > 0) {
    warnings.push(
      `${noUah} receipt${noUah === 1 ? ' has' : 's have'} no hryvnia amount in the file and ${noUah === 1 ? 'is' : 'are'} not counted.`,
    );
  }

  const esvMonthly = FOP_ESV_MONTHLY_UAH_MINOR[year];
  const periods: FopPeriod[] = [];
  let cumulative = 0;
  let cumulativeTax = 0;
  let cumulativeLevy = 0;
  for (let quarter = 1; quarter <= quarters; quarter += 1) {
    const range = quarterRange(year, quarter);
    const mine = counted.filter((j) => quarterOf(j.record.day) === quarter);
    const income = mine.reduce((sum, j) => sum + (j.record.uahMinor ?? 0), 0);
    cumulative += income;
    const tax = percentOf(cumulative, options.singleTaxPercent);
    const levy = percentOf(cumulative, FOP_MILITARY_LEVY_PERCENT);
    periods.push({
      quarter,
      ...range,
      incomeMinor: income,
      cumulativeMinor: cumulative,
      singleTaxMinor: tax - cumulativeTax,
      levyMinor: levy - cumulativeLevy,
      paidSingleTaxMinor: paid.get(`tax-single:${quarter}`) ?? 0,
      paidLevyMinor: paid.get(`tax-levy:${quarter}`) ?? 0,
      paidEsvMinor: judged
        .filter((j) => j.record.kind === 'esv' && quarterOf(j.record.day) === quarter)
        .reduce((sum, j) => sum + j.record.amountMinor, 0),
      esvMinimumMinor: esvMonthly === undefined ? null : esvMonthly * 3,
      rows: mine.length,
      periodName: FOP_PERIOD_NAMES[quarter - 1] ?? '',
      lines: declarationLines(
        options.singleTaxPercent,
        cumulative,
        tax,
        cumulativeTax,
        levy,
        cumulativeLevy,
      ),
    });
    cumulativeTax = tax;
    cumulativeLevy = levy;
  }

  const currencies = new Map<string, { amountMinor: number; uahMinor: number }>();
  for (const { record } of counted) {
    if (record.currency === 'UAH') continue;
    const have = currencies.get(record.currency) ?? { amountMinor: 0, uahMinor: 0 };
    have.amountMinor += record.amountMinor;
    have.uahMinor += record.uahMinor ?? 0;
    currencies.set(record.currency, have);
  }

  const limitUah = FOP_INCOME_LIMIT_UAH[year];
  const limitMinor = limitUah === undefined ? null : limitUah * 100;

  const rows: FopRow[] = judged
    .filter(
      ({ record }) =>
        record.direction === 'in' ||
        record.kind === 'tax-single' ||
        record.kind === 'tax-levy' ||
        record.kind === 'esv',
    )
    .map(({ record, counted: isCounted, chosen, reason }) => ({
      id: record.id,
      ts: record.ts,
      day: record.day,
      account: record.account,
      currency: record.currency,
      direction: record.direction,
      amountMinor: record.amountMinor,
      uahMinor: record.uahMinor,
      counterparty: record.counterparty,
      purpose: record.purpose,
      kind: record.kind,
      counted: isCounted,
      chosen,
      reason,
    }))
    .sort((a, b) => b.ts - a.ts);

  const coverage = new Map<string, FopAccountCoverage>();
  for (const record of records) {
    const key = `${record.account}:${record.currency}`;
    const have = coverage.get(key);
    if (!have) {
      coverage.set(key, {
        account: record.account,
        currency: record.currency,
        from: record.day,
        to: record.day,
        rows: 1,
      });
    } else {
      have.rows += 1;
      if (record.day < have.from) have.from = record.day;
      if (record.day > have.to) have.to = record.day;
    }
  }

  return {
    year,
    years,
    singleTaxPercent: options.singleTaxPercent,
    militaryLevyPercent: FOP_MILITARY_LEVY_PERCENT,
    periods,
    yearIncomeMinor: cumulative,
    yearSingleTaxMinor: cumulativeTax,
    yearLevyMinor: cumulativeLevy,
    limit:
      limitMinor === null
        ? null
        : { limitMinor, usedPercent: Math.round((cumulative * 1000) / limitMinor) / 10 },
    currencies: [...currencies.entries()]
      .map(([currency, sums]) => ({ currency, ...sums }))
      .sort((a, b) => a.currency.localeCompare(b.currency)),
    rows,
    accounts: [...coverage.values()].sort((a, b) =>
      `${a.currency}${a.account}`.localeCompare(`${b.currency}${b.account}`),
    ),
    warnings,
    hasData: records.length > 0,
  };
}
