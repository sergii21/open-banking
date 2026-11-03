import type { Category, Insights, RegularPayment } from '@ledger-lens/contracts';
import type { SessionRecord } from '../../db/repos';
import { type Calendar, addMonths } from '../../domain/calendar';
import { detectRecurring, merchantKey, summarise } from '../../domain/insights';
import { toUahRows } from '../../domain/uah-rows';
import { notFound } from '../../errors';
import type { CoreContext } from '../../types';
import type { RatesService } from '../rates/service';

const THIRTEEN_MONTHS_MS = 400 * 86_400_000;

export class InsightsService {
  constructor(
    private readonly core: CoreContext,
    private readonly rates: RatesService,
    private readonly calendar: Calendar,
  ) {}

  async build(session: SessionRecord, requested?: string): Promise<Insights> {
    const { repos, clock } = this.core;
    const connection = repos.connections.findBySession(session.id);
    if (!connection) throw notFound('Connection');
    const now = clock.now();
    const today = this.calendar.today(now);
    const accounts = repos.accounts.listByConnection(connection.id);
    const { table } = await this.rates.get(connection);
    const records = repos.transactions.listForSession(
      session.id,
      now.getTime() - THIRTEEN_MONTHS_MS,
    );
    const { items, converted } = toUahRows(records, accounts, table, this.calendar);

    const currentMonth = today.slice(0, 7);
    const monthsWithData = [...new Set(items.map((i) => i.day.slice(0, 7)))].sort().reverse();
    if (!monthsWithData.includes(currentMonth)) monthsWithData.unshift(currentMonth);
    const month =
      requested && /^\d{4}-\d{2}$/.test(requested) && requested <= currentMonth
        ? requested
        : currentMonth;
    const previousMonth = addMonths(month, -1);

    const window = (m: string) => ({ from: `${m}-01`, to: `${m}-31` });
    const forMonth = summarise(items, window(month))[0];
    const forPrevious = summarise(items, window(previousMonth))[0];

    const cards = accounts.filter((a) => a.kind === 'card');
    const covers = (m: string): boolean =>
      cards.length > 0 && cards.every((a) => a.coveredFrom !== null && a.coveredFrom <= `${m}-01`);
    const previousKnown = covers(previousMonth);
    const previousByCategory = new Map(
      forPrevious?.categories.map((c) => [c.category, c.spentMinor]),
    );

    // Top merchants: the same payee grouped the way the standing-payment detector groups it.
    const merchants = new Map<
      string,
      { name: string; spentMinor: number; count: number; counts: Map<Category, number> }
    >();
    for (const item of items) {
      if (!item.day.startsWith(month)) continue;
      if (item.category === 'transfers' || item.category === 'income' || item.amountMinor >= 0)
        continue;
      const key = merchantKey(item);
      if (!key) continue;
      const entry = merchants.get(key) ?? {
        name: item.counterparty ?? item.description,
        spentMinor: 0,
        count: 0,
        counts: new Map(),
      };
      entry.spentMinor += -item.amountMinor;
      entry.count += 1;
      entry.counts.set(item.category, (entry.counts.get(item.category) ?? 0) + 1);
      merchants.set(key, entry);
    }

    const regular: RegularPayment[] = detectRecurring(
      items.filter((i) => i.amountMinor < 0),
      now,
    ).map((r) => ({
      key: r.key,
      merchant: r.merchant,
      category: r.category,
      cadence: r.cadence,
      amountMinor: r.amountMinor,
      occurrences: r.occurrences,
      lastSeenAt: r.lastSeenAt,
      nextExpectedAt: r.nextExpectedAt,
      monthlyMinor: r.monthlyEquivalentMinor,
    }));

    const states = repos.syncJobs.progress(connection.id);
    return {
      month,
      months: monthsWithData,
      spentMinor: forMonth?.totalOutMinor ?? 0,
      incomeMinor: forMonth?.totalInMinor ?? 0,
      previousSpentMinor: previousKnown ? (forPrevious?.totalOutMinor ?? 0) : null,
      categories: (forMonth?.categories ?? []).map((c) => ({
        category: c.category,
        spentMinor: c.spentMinor,
        count: c.count,
        share: c.share,
        previousMinor: previousKnown ? (previousByCategory.get(c.category) ?? 0) : null,
      })),
      merchants: [...merchants.values()]
        .sort((a, b) => b.spentMinor - a.spentMinor)
        .slice(0, 8)
        .map((m) => ({
          name: m.name,
          spentMinor: m.spentMinor,
          count: m.count,
          category: [...m.counts].sort(([, a], [, b]) => b - a)[0]?.[0] ?? 'other',
        })),
      regular,
      regularMonthlyMinor: regular.reduce((sum, r) => sum + r.monthlyMinor, 0),
      partial: !covers(month) || (month === currentMonth && states.pending > 0),
      converted,
    };
  }
}
