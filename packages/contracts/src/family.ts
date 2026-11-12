import { CATEGORIES, type Category } from './model';

/**
 * Family mode: each person's phone reads its own bank with its own token and shares a summary of the month, never the
 * token and never a transaction. The summary is encrypted on the phone with a key only the family holds and kept by a
 * relay that cannot read it. These are the summary's shape, the checks a phone runs on one it received, and the view
 * the family screen is built from. Everything is in hryvnias, integer kopiykas.
 */

export const FAMILY_SUMMARY_VERSION = 1;
/** The relay refuses more people than this in one family. */
export const FAMILY_MAX_MEMBERS = 8;
/** The relay refuses a sealed summary larger than this, in bytes. */
export const FAMILY_MAX_BLOB_BYTES = 32 * 1024;
/** A summary nobody renewed for this long is removed by the relay. */
export const FAMILY_EXPIRY_DAYS = 90;
export const FAMILY_NAME_MAX = 40;

export interface FamilyMonth {
  /** YYYY-MM, a Kyiv calendar month. */
  month: string;
  /** Spending net of refunds, transfers left out: the same rules as Insights. */
  spentMinor: number;
  incomeMinor: number;
  byCategory: Partial<Record<Category, number>>;
}

/** The family's monthly budget. Every phone carries the newest one it has seen, so it outlives the person who set it. */
export interface FamilyBudget {
  /** 0 means no budget. */
  monthlyMinor: number;
  /** Unix milliseconds: the newest wins. */
  setAt: number;
  setBy: string;
}

export interface FamilySummary {
  v: typeof FAMILY_SUMMARY_VERSION;
  memberId: string;
  name: string;
  /** Unix milliseconds on the phone that made it. */
  updatedAt: number;
  /** The person's own money in hryvnias, or null when they chose not to share it (or have no bank connected). */
  balanceMinor: number | null;
  months: FamilyMonth[];
  budget: FamilyBudget | null;
}

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A summary came from another phone through the relay: it is checked field by field and anything that is not what this
 * file describes makes the whole summary null, so one odd phone cannot break the family screen.
 */
export function parseFamilySummary(value: unknown): FamilySummary | null {
  if (!isObject(value) || value['v'] !== FAMILY_SUMMARY_VERSION) return null;
  const { memberId, name, updatedAt, balanceMinor, months, budget } = value;
  if (typeof memberId !== 'string' || !/^[0-9a-f]{16,32}$/.test(memberId)) return null;
  if (typeof name !== 'string' || !isCount(updatedAt) || !Array.isArray(months)) return null;
  if (
    balanceMinor !== null &&
    !(typeof balanceMinor === 'number' && Number.isSafeInteger(balanceMinor))
  ) {
    return null;
  }
  const parsedMonths: FamilyMonth[] = [];
  for (const entry of months.slice(0, 12) as unknown[]) {
    if (!isObject(entry)) return null;
    const month = entry['month'];
    const spentMinor = entry['spentMinor'];
    const incomeMinor = entry['incomeMinor'];
    const cells = entry['byCategory'];
    if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) return null;
    if (!isCount(spentMinor) || !isCount(incomeMinor) || !isObject(cells)) return null;
    const byCategory: Partial<Record<Category, number>> = {};
    for (const category of CATEGORIES) {
      const amount = cells[category];
      if (amount === undefined) continue;
      if (!isCount(amount)) return null;
      byCategory[category] = amount;
    }
    parsedMonths.push({ month, spentMinor, incomeMinor, byCategory });
  }
  let parsedBudget: FamilyBudget | null = null;
  if (budget !== null && budget !== undefined) {
    if (!isObject(budget)) return null;
    const monthlyMinor = budget['monthlyMinor'];
    const setAt = budget['setAt'];
    const setBy = budget['setBy'];
    if (!isCount(monthlyMinor) || !isCount(setAt) || typeof setBy !== 'string') return null;
    parsedBudget = { monthlyMinor, setAt, setBy: setBy.slice(0, FAMILY_NAME_MAX) };
  }
  return {
    v: FAMILY_SUMMARY_VERSION,
    memberId,
    name: name.trim().slice(0, FAMILY_NAME_MAX) || 'Someone',
    updatedAt,
    balanceMinor,
    months: parsedMonths,
    budget: parsedBudget,
  };
}

/** The newest budget among the summaries, or null when nobody has one or the newest says "no budget". */
export function newestBudget(summaries: readonly FamilySummary[]): FamilyBudget | null {
  let newest: FamilyBudget | null = null;
  for (const { budget } of summaries) {
    if (budget && (newest === null || budget.setAt > newest.setAt)) newest = budget;
  }
  return newest;
}

export interface FamilyMemberLine {
  memberId: string;
  name: string;
  updatedAt: number;
  spentMinor: number;
  incomeMinor: number;
  /** Share of the family's spending this month, 0..1. */
  share: number;
  balanceMinor: number | null;
  /** The person's phone has no figures for this month (it has not been opened since the month began). */
  noMonth: boolean;
}

export interface FamilyView {
  month: string;
  members: FamilyMemberLine[];
  spentMinor: number;
  incomeMinor: number;
  categories: { category: Category; spentMinor: number; share: number }[];
  /** The money of everyone who shares a balance, and how many people do not. */
  balanceMinor: number;
  balancesShared: number;
  balancesHidden: number;
  budget: {
    monthlyMinor: number;
    /** Negative when the family has spent more than the budget. */
    leftMinor: number;
    /** Whole percent, not capped at 100. */
    usedPercent: number;
    setBy: string;
  } | null;
}

/** One month of the whole family, biggest spender first. Nothing here is rounded: kopiykas are added as integers. */
export function buildFamilyView(summaries: readonly FamilySummary[], month: string): FamilyView {
  const byCategory = new Map<Category, number>();
  let spentMinor = 0;
  let incomeMinor = 0;
  let balanceMinor = 0;
  let balancesShared = 0;
  const lines = summaries.map((summary): FamilyMemberLine => {
    const figures = summary.months.find((entry) => entry.month === month);
    spentMinor += figures?.spentMinor ?? 0;
    incomeMinor += figures?.incomeMinor ?? 0;
    for (const category of CATEGORIES) {
      const amount = figures?.byCategory[category] ?? 0;
      if (amount > 0) byCategory.set(category, (byCategory.get(category) ?? 0) + amount);
    }
    if (summary.balanceMinor !== null) {
      balanceMinor += summary.balanceMinor;
      balancesShared += 1;
    }
    return {
      memberId: summary.memberId,
      name: summary.name,
      updatedAt: summary.updatedAt,
      spentMinor: figures?.spentMinor ?? 0,
      incomeMinor: figures?.incomeMinor ?? 0,
      share: 0,
      balanceMinor: summary.balanceMinor,
      noMonth: figures === undefined,
    };
  });
  const members = lines
    .map((line) => ({ ...line, share: spentMinor === 0 ? 0 : line.spentMinor / spentMinor }))
    .sort((a, b) => b.spentMinor - a.spentMinor || a.name.localeCompare(b.name));
  const categoryTotal = [...byCategory.values()].reduce((sum, amount) => sum + amount, 0);
  const categories = [...byCategory]
    .sort(([ca, a], [cb, b]) => b - a || ca.localeCompare(cb))
    .map(([category, amount]) => ({
      category,
      spentMinor: amount,
      share: categoryTotal === 0 ? 0 : amount / categoryTotal,
    }));
  const budget = newestBudget(summaries);
  return {
    month,
    members,
    spentMinor,
    incomeMinor,
    categories,
    balanceMinor,
    balancesShared,
    balancesHidden: summaries.length - balancesShared,
    budget:
      budget && budget.monthlyMinor > 0
        ? {
            monthlyMinor: budget.monthlyMinor,
            leftMinor: budget.monthlyMinor - spentMinor,
            usedPercent: Math.round((spentMinor / budget.monthlyMinor) * 100),
            setBy: budget.setBy,
          }
        : null,
  };
}
