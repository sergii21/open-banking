import type { SessionRecord } from '../../db/repos';
import { balanceVersusLimit, statementContinuity } from '../../domain/checks';
import {
  renderDiagnostics,
  type DiagnosticsSection,
  type FactValue,
} from '../../domain/diagnostics';
import type { CoreContext } from '../../types';
import { APP_NAME, APP_VERSION } from '../../version';
import { LABEL_OF, primaryConnection } from '../connection/presenter';
import type { RatesService } from '../rates/service';
import type { ProviderRegistry } from '../../providers/registry';
import type { SyncService } from '../sync/service';

const count = (values: readonly string[]): string => {
  const tally = new Map<string, number>();
  for (const value of values) tally.set(value, (tally.get(value) ?? 0) + 1);
  return [...tally]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, n]) => `${key}×${n}`)
    .join(' ');
};

/**
 * The block the person copies from Settings when real data surprises us. Built from counts and yes/no answers about stored
 * data and from the adapter's own record of what the bank sent (field names and types, never values). See
 * `domain/diagnostics.ts`.
 */
export class DiagnosticsService {
  constructor(
    private readonly core: CoreContext,
    private readonly providers: ProviderRegistry,
    private readonly sync: SyncService,
    private readonly rates: RatesService,
  ) {}

  async build(session: SessionRecord): Promise<string> {
    const { repos, clock } = this.core;
    const connections = repos.connections.listBySession(session.id);
    const primary = primaryConnection(connections);
    const sections: DiagnosticsSection[] = connections.map((c) => ({
      title: LABEL_OF[c.provider],
      snapshot: this.providers.diagnostics(c.provider).snapshot(),
      ...(c.kind === 'file' ? { file: true } : {}),
    }));
    const facts: Record<string, FactValue> = {};

    if (primary) {
      facts['connections'] = connections
        .map((c) => `${LABEL_OF[c.provider]} (${c.kind}, ${c.status})`)
        .join(', ');
      const accounts = repos.accounts.listBySession(session.id);
      const cards = accounts.filter((a) => a.kind === 'card');
      facts['accounts'] = `${cards.length} cards, ${accounts.length - cards.length} jars`;
      facts['card types'] = count(cards.map((a) => a.cardType)) || 'none';
      facts['currencies'] = count(accounts.map((a) => a.currency)) || 'none';
      const credit = cards.filter((a) => a.creditLimitMinor > 0);
      facts['cards with a credit limit'] = credit.length;
      facts['their balance against the limit (assumed to include it)'] = credit.length
        ? count(credit.map((a) => balanceVersusLimit(a.balanceMinor, a.creditLimitMinor)))
        : 'n/a';
      facts['jar goals set'] = accounts.filter((a) => a.goalMinor !== null).length;
      facts['accounts with no balance (imported file without one)'] = accounts.filter(
        (a) => !a.balanceKnown,
      ).length;

      const records = repos.transactions.listForSession(session.id, 0);
      facts['transactions stored'] = records.length;
      facts['pending (hold)'] = records.filter((r) => r.status === 'pending').length;
      facts['with a merchant code (mcc)'] = records.filter((r) => r.mcc !== null).length;
      facts['with a balance after'] = records.filter((r) => r.balanceAfterMinor !== null).length;
      facts['with cashback'] = records.filter((r) => r.cashbackMinor > 0).length;
      facts['with a commission'] = records.filter((r) => r.commissionMinor > 0).length;
      facts['with a comment'] = records.filter((r) => r.comment !== null).length;
      facts['categories chosen by the person'] = records.filter(
        (r) => r.categorySource === 'user',
      ).length;
      facts['categorised as other'] = records.filter((r) => r.category === 'other').length;

      let pairs = 0;
      let consistent = 0;
      for (const account of accounts) {
        const result = statementContinuity(
          records
            .filter((r) => r.accountId === account.id && r.balanceAfterMinor !== null)
            .map((r) => ({
              ts: r.ts,
              amountMinor: r.amountMinor,
              balanceAfterMinor: r.balanceAfterMinor,
              pending: r.status === 'pending',
            })),
        );
        pairs += result.pairs;
        consistent += result.consistent;
      }
      facts['statement balance is the balance after each item (assumed)'] = pairs
        ? `${consistent} of ${pairs} consecutive pairs agree (${Math.round((consistent / pairs) * 100)}%)`
        : 'not enough data yet';

      const { table, stale } = await this.rates.get(primary);
      facts['rates'] = table.isEmpty()
        ? 'none'
        : `${table.pairs.length} pairs, ${stale ? 'last refresh failed' : 'fresh'}`;
      facts['accounts without a rate to hryvnias'] = accounts.filter(
        (a) => table.perUnit(a.currency) === null,
      ).length;

      const sync = this.sync.stateForSession(session.id);
      facts['history months requested'] = connections
        .filter((c) => c.kind === 'api')
        .map((c) => c.historyMonths)
        .join(' / ');
      facts['sync'] =
        `${sync.phase}, ${sync.done} of ${sync.total} steps${sync.message ? `, note: ${sync.message}` : ''}`;
      facts['cards with history loaded'] =
        `${cards.filter((a) => a.coveredFrom !== null).length} of ${cards.length}`;
    }
    facts['time zone'] = this.core.config.timeZone;

    return renderDiagnostics({
      app: APP_NAME,
      version: APP_VERSION,
      provider:
        connections.length > 0
          ? connections.map((c) => `${c.provider} (${c.status})`).join(' + ')
          : 'not connected',
      generatedAt: clock.now().toISOString(),
      sections,
      facts,
    });
  }
}
