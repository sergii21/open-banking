import type { ImportResult } from '@ledger-lens/contracts';
import type { SessionRecord } from '../../db/repos';
import type { Calendar } from '../../domain/calendar';
import { categorise } from '../../domain/categoriser';
import { newId } from '../../domain/crypto';
import { readCsv } from '../../domain/files/csv';
import { readXlsx } from '../../domain/files/xlsx';
import { ZipError } from '../../domain/files/zip';
import {
  parsePrivat24Statement,
  StatementError,
  type ParsedStatement,
} from '../../domain/privat24-statement';
import { AppError } from '../../errors';
import type { ProviderRegistry } from '../../providers/registry';
import type { CoreContext } from '../../types';
import type { ConnectionAccess } from '../connection/access';
import { primaryConnection, toConnectionInfo } from '../connection/presenter';
import type { RatesService } from '../rates/service';
import type { SyncService } from '../sync/service';

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/**
 * Reads a statement file the person exported from Privat24 and stores its rows. The file itself is never stored: the bytes are
 * parsed in memory and dropped. Importing again adds what is new and leaves what is already here (see the stable ids in
 * `privat24-statement.ts`), so overlapping periods are fine. There is no token and nothing to sync: the connection is a file.
 */
export class ImportService {
  constructor(
    private readonly core: CoreContext,
    private readonly providers: ProviderRegistry,
    private readonly access: ConnectionAccess,
    private readonly sync: SyncService,
    private readonly rates: RatesService,
    private readonly calendar: Calendar,
  ) {}

  private table(bytes: Buffer): string[][] {
    try {
      return ZIP_MAGIC.every((byte, i) => bytes[i] === byte) ? readXlsx(bytes) : readCsv(bytes);
    } catch (error) {
      if (error instanceof ZipError) {
        throw new AppError(
          'unsupported_file',
          422,
          'That file could not be opened as an Excel (.xlsx) workbook. Export the statement again, or choose CSV.',
        );
      }
      throw error;
    }
  }

  privat24(session: SessionRecord, bytes: Buffer): ImportResult {
    if (!this.core.config.live) {
      throw new AppError(
        'provider_not_available',
        403,
        'Statements can only be imported when the app runs on your own computer.',
      );
    }
    const diagnostics = this.providers.diagnostics('privat24');
    let parsed: ParsedStatement;
    try {
      parsed = parsePrivat24Statement(this.table(bytes), this.calendar);
    } catch (error) {
      if (!(error instanceof StatementError)) throw error;
      diagnostics.warn('import: refused a file (the required columns were not found)');
      throw new AppError(
        'unsupported_file',
        422,
        error.headers.length > 0
          ? `${error.message} Columns found: ${error.headers.join(' · ')}.`
          : `${error.message} No column titles were found.`,
        { errors: error.headers.map((title) => ({ path: 'columns', message: title })) },
      );
    }

    const { repos, clock } = this.core;
    const nowIso = clock.now().toISOString();
    const before = repos.connections.listBySession(session.id);
    const cards = this.core.db.transaction(() => {
      // Imported money is the person's own, so it replaces the demo like any real bank does.
      for (const demo of before.filter((c) => c.provider === 'demo'))
        repos.connections.delete(demo.id);
      let connection = repos.connections.findByProvider(session.id, 'privat24');
      if (!connection) {
        const id = newId('con');
        repos.connections.insert({
          id,
          sessionId: session.id,
          provider: 'privat24',
          kind: 'file',
          tokensEnc: null,
          historyMonths: 0,
          now: nowIso,
        });
        connection = repos.connections.findById(id) ?? undefined;
      }
      if (!connection) throw new Error('connection was not stored');
      repos.connections.update(
        connection.id,
        { lastRefreshedAt: nowIso, status: 'active' },
        nowIso,
      );

      const groups = new Map<
        string,
        { last4: string | null; currency: string; rows: typeof parsed.rows }
      >();
      for (const row of parsed.rows) {
        const key = `${row.last4 ?? 'x'}:${row.currency}`;
        const group = groups.get(key) ?? { last4: row.last4, currency: row.currency, rows: [] };
        group.rows.push(row);
        groups.set(key, group);
      }
      const periodEnd = Math.min(this.calendar.dayEnd(parsed.period.to), clock.now().getTime());
      return [...groups.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, group], sort) => {
          const providerAccountId = `file:${key}`;
          const existing = repos.accounts.findByProviderId(connection.id, providerAccountId);
          const balance = group.rows.find((r) => r.balanceMinor !== null)?.balanceMinor ?? null;
          // An older statement never replaces the balance a newer one brought.
          const keepOld =
            existing?.balanceKnown === true &&
            (balance === null ||
              (existing.coveredTo !== null && existing.coveredTo > parsed.period.to));
          const account = repos.accounts.upsert(connection.id, {
            providerAccountId,
            kind: 'card',
            cardType: 'privat24',
            name: 'Privat24 card',
            currency: group.currency,
            last4: group.last4,
            creditLimitMinor: 0,
            balanceMinor: keepOld ? (existing?.balanceMinor ?? 0) : (balance ?? 0),
            goalMinor: null,
            sort,
            balanceAt: keepOld
              ? (existing?.balanceAt ?? nowIso)
              : new Date(periodEnd).toISOString(),
            balanceKnown: keepOld ? true : balance !== null,
          });
          const added = repos.transactions.upsertMany(
            account.id,
            group.rows.map((row) => ({
              providerTxnId: row.id,
              ts: row.ts,
              status: 'booked' as const,
              amountMinor: row.amountMinor,
              currency: row.currency,
              description: row.description,
              counterparty: null,
              category: categorise({
                description: row.description,
                counterparty: null,
                comment: null,
                amountMinor: row.amountMinor,
                mcc: null,
                fop: false,
              }),
              mcc: null,
              cashbackMinor: 0,
              commissionMinor: 0,
              comment: null,
              receiptId: null,
              balanceAfterMinor: null,
            })),
          );
          repos.accounts.extendCoverage(account.id, parsed.period.from, parsed.period.to, nowIso);
          const fresh = repos.accounts.findById(account.id);
          return {
            accountId: account.id,
            last4: group.last4,
            currency: group.currency,
            added,
            updated: group.rows.length - added,
            balanceKnown: fresh?.balanceKnown ?? false,
          };
        });
    });

    // What was seen, as counts and column titles: the person can copy this to us, so it holds no value from the file.
    diagnostics.observeRows(
      'statement file',
      parsed.rows
        .slice(0, 200)
        .map(() => Object.fromEntries(parsed.headers.used.map((title) => [title, 'x']))),
      new Set(parsed.headers.used),
    );
    diagnostics.observeRows(
      'statement file (columns not used)',
      [Object.fromEntries(parsed.headers.unused.map((title) => [title, 'x']))],
      new Set(),
    );
    if (parsed.skipped > 0)
      diagnostics.warn('import: skipped lines that were not transactions', parsed.skipped);
    if (parsed.notes.some((n) => n.includes('no currency column'))) {
      diagnostics.warn('import: no currency column, amounts taken as UAH');
    }

    this.access.notifySession(session.id);
    this.sync.touch(session.id);
    const connections = repos.connections.listBySession(session.id);
    const primary = primaryConnection(connections);
    if (primary) this.rates.warm(primary);

    const added = cards.reduce((n, c) => n + c.added, 0);
    return {
      connections: connections.map(toConnectionInfo),
      period: parsed.period,
      rows: {
        read: parsed.rows.length,
        added,
        updated: parsed.rows.length - added,
        skipped: parsed.skipped,
      },
      cards,
      notes: parsed.notes,
    };
  }
}
