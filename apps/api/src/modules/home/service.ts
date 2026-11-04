import type { Home, RatesInfo } from '@ledger-lens/contracts';
import type { AccountRecord, SessionRecord } from '../../db/repos';
import { type Calendar, addDays, addMonths, daysInMonth } from '../../domain/calendar';
import { detectRecurring, summarise } from '../../domain/insights';
import { dailySpend, sumMap, toUahRows } from '../../domain/uah-rows';
import { balanceTrend, type TrendAccount } from '../../domain/trend';
import { notFound } from '../../errors';
import type { CoreContext } from '../../types';
import { primaryConnection } from '../connection/presenter';
import type { RatesService } from '../rates/service';
import type { SyncService } from '../sync/service';
import { toAccountDto } from './presenter';

const TREND_DAYS = 30;
const THIRTEEN_MONTHS_MS = 400 * 86_400_000;

export class HomeService {
  constructor(
    private readonly core: CoreContext,
    private readonly sync: SyncService,
    private readonly rates: RatesService,
    private readonly calendar: Calendar,
  ) {}

  /** Whether every card's loaded history reaches back to `day` (jars do not matter for spending). */
  private cardsCover(accounts: readonly AccountRecord[], day: string): boolean {
    // A bank read for balances only (Wise) has no history to wait for.
    const cards = accounts.filter((a) => a.kind === 'card' && a.cardType !== 'wise');
    return cards.length > 0 && cards.every((a) => a.coveredFrom !== null && a.coveredFrom <= day);
  }

  async build(session: SessionRecord): Promise<Home> {
    const { repos, clock } = this.core;
    const connections = repos.connections.listBySession(session.id);
    const primary = primaryConnection(connections);
    if (!primary) throw notFound('Connection');

    const now = clock.now();
    const today = this.calendar.today(now);
    const month = today.slice(0, 7);
    const dom = Number(today.slice(8, 10));
    const dim = daysInMonth(month);
    const monthStart = `${month}-01`;
    const previousMonth = addMonths(month, -1);
    const previousStart = `${previousMonth}-01`;
    const previousEnd = `${previousMonth}-${String(Math.min(dom, daysInMonth(previousMonth))).padStart(2, '0')}`;

    const accounts = repos.accounts.listBySession(session.id);
    const connectionsById = new Map(connections.map((c) => [c.id, c]));
    const states = this.sync.accountStates(session.id);
    const { table, stale } = await this.rates.get(primary);

    // Hero: own money in hryvnias, with and without the credit limit.
    let own = 0;
    let available = 0;
    let unconverted = 0;
    let unknownBalance = 0;
    for (const account of accounts) {
      if (!account.balanceKnown) {
        unknownBalance += 1;
        continue;
      }
      const ownUah = table.toUahMinor(
        account.balanceMinor - account.creditLimitMinor,
        account.currency,
      );
      const availableUah = table.toUahMinor(account.balanceMinor, account.currency);
      if (ownUah === null || availableUah === null) {
        unconverted += 1;
        continue;
      }
      own += ownUah;
      available += availableUah;
    }

    const records = repos.transactions.listForSession(
      session.id,
      now.getTime() - THIRTEEN_MONTHS_MS,
    );
    const { items } = toUahRows(records, accounts, table, this.calendar);

    // This month against the same days last month. A delta needs last month loaded for every card, or it is not shown.
    const spendThis = dailySpend(items, monthStart, today);
    const spentMinor = sumMap(spendThis);
    const previousLoaded = this.cardsCover(accounts, previousStart);
    const previousSameDaysMinor = previousLoaded
      ? sumMap(dailySpend(items, previousStart, previousEnd))
      : null;
    const daily = Array.from({ length: dim }, (_, i) => {
      const day = `${month}-${String(i + 1).padStart(2, '0')}`;
      return day <= today ? (spendThis.get(day) ?? 0) : 0;
    });
    const incomeMinor = items
      .filter(
        (i) =>
          i.day >= monthStart && i.day <= today && i.category === 'income' && i.amountMinor > 0,
      )
      .reduce((sum, i) => sum + i.amountMinor, 0);
    // Pace: what the last 30 days cost per day, for the days still to come. Needs those 30 days loaded for every card.
    let projectedMinor: number | null = null;
    if (dom < dim && this.cardsCover(accounts, addDays(today, -30))) {
      const lastThirty = sumMap(dailySpend(items, addDays(today, -30), addDays(today, -1)));
      projectedMinor = spentMinor + Math.round((lastThirty / 30) * (dim - dom));
    }

    const categories = (summarise(items, { from: monthStart, to: today })[0]?.categories ?? [])
      .slice(0, 5)
      .map((c) => ({ category: c.category, spentMinor: c.spentMinor, share: c.share }));

    const recurring = detectRecurring(
      items.filter((i) => i.amountMinor < 0),
      now,
    );

    // Trend of own money over the last 30 days, from the statement's own balance field.
    const days = Array.from({ length: TREND_DAYS }, (_, i) => addDays(today, i - (TREND_DAYS - 1)));
    const rowsByAccount = new Map<string, TrendAccount['rows'][number][]>();
    for (const record of records) {
      if (record.balanceAfterMinor === null) continue;
      const list = rowsByAccount.get(record.accountId) ?? [];
      list.push({
        ts: record.ts,
        amountMinor: record.amountMinor,
        balanceAfterMinor: record.balanceAfterMinor,
      });
      rowsByAccount.set(record.accountId, list);
    }
    const flowsByAccount = new Map<string, { ts: number; amountMinor: number }[]>();
    for (const record of records) {
      if (record.status !== 'booked') continue;
      const list = flowsByAccount.get(record.accountId) ?? [];
      list.push({ ts: record.ts, amountMinor: record.amountMinor });
      flowsByAccount.set(record.accountId, list);
    }
    const trendAccounts: TrendAccount[] = accounts
      .filter((account) => account.balanceKnown)
      .map((account) => ({
        currency: account.currency,
        creditLimitMinor: account.creditLimitMinor,
        currentBalanceMinor: account.balanceMinor,
        // No history is read for Wise: its balance counts as it is now, all along the line.
        coveredFrom: account.cardType === 'wise' ? '0000-01-01' : account.coveredFrom,
        isJar: account.kind === 'jar',
        // Records come newest first; the trend walks forward in time.
        rows: [...(rowsByAccount.get(account.id) ?? [])].reverse(),
        // A bank that reports no balance after each item (PrivatBank, a statement file): walk back from the balance now instead.
        flows:
          account.cardType === 'business' || account.cardType === 'privat24'
            ? (flowsByAccount.get(account.id) ?? [])
            : null,
      }));
    // A statement that stops before yesterday leaves the days since unknown: a flat line would claim nothing happened. With no
    // account whose balance is known there is nothing to draw either.
    const staleStatement = accounts.some(
      (a) =>
        a.balanceKnown &&
        connectionsById.get(a.connectionId)?.kind === 'file' &&
        a.coveredTo !== null &&
        a.coveredTo < addDays(today, -1),
    );
    const trend =
      trendAccounts.length > 0 && !staleStatement
        ? balanceTrend(trendAccounts, days, (day) => this.calendar.dayEnd(day), table)
        : null;

    const ratesInfo: RatesInfo = {
      asOf: table.asOf(),
      stale,
      perUnit: Object.fromEntries(
        [...new Set(accounts.map((a) => a.currency))]
          .filter((c) => c !== 'UAH')
          .flatMap((c) => {
            const rate = table.perUnit(c);
            return rate === null ? [] : [[c, rate] as const];
          }),
      ),
    };

    return {
      asOf: accounts.reduce((latest, a) => (a.balanceAt > latest ? a.balanceAt : latest), ''),
      demo: connections.some((c) => c.provider === 'demo'),
      hero: { ownUahMinor: own, availableUahMinor: available, unconverted, unknownBalance },
      rates: ratesInfo,
      trend: trend ? { from: days[0] ?? today, points: trend.points } : null,
      month: {
        label: month,
        daysElapsed: dom,
        daysInMonth: dim,
        spentMinor,
        incomeMinor,
        previousSameDaysMinor,
        daily,
        projectedMinor,
      },
      accounts: accounts.map((account) =>
        toAccountDto(
          account,
          states.get(account.id),
          table,
          connectionsById.get(account.connectionId),
        ),
      ),
      topCategories: categories,
      regular: {
        count: recurring.length,
        monthlyMinor: recurring.reduce((sum, r) => sum + r.monthlyEquivalentMinor, 0),
      },
      sync: this.sync.stateForSession(session.id),
    };
  }
}
