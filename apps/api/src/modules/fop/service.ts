import type { FopImportResult, FopRate, FopReport } from '@ledger-lens/contracts';
import type { SessionRecord } from '../../db/repos';
import type { Calendar } from '../../domain/calendar';
import { readCsv } from '../../domain/files/csv';
import { buildFopReport } from '../../domain/fop-report';
import { StatementError } from '../../domain/privat24-statement';
import { parseUkrsibStatement } from '../../domain/ukrsib-statement';
import { AppError, notFound } from '../../errors';
import type { CoreContext } from '../../types';

/**
 * The ФОП report: reads UKRSIB business statement files (CSV), keeps their rows apart from the personal accounts, and adds the
 * income up per quarter. Nothing here talks to a bank. The file is parsed in memory and dropped; only its rows are stored.
 */
export class FopService {
  constructor(
    private readonly core: CoreContext,
    private readonly calendar: Calendar,
  ) {}

  private requireLive(): void {
    if (!this.core.config.live) {
      throw new AppError(
        'provider_not_available',
        403,
        'Statements can only be imported when the app runs on your own computer.',
      );
    }
  }

  importUkrsib(session: SessionRecord, bytes: Buffer): FopImportResult {
    this.requireLive();
    let parsed;
    try {
      parsed = parseUkrsibStatement(readCsv(bytes), this.calendar);
    } catch (error) {
      if (!(error instanceof StatementError)) throw error;
      throw new AppError(
        'unsupported_file',
        422,
        error.headers.length > 0
          ? `${error.message} Columns found: ${error.headers.join(' · ')}.`
          : `${error.message} No column titles were found.`,
        { errors: error.headers.map((title) => ({ path: 'columns', message: title })) },
      );
    }
    const added = this.core.repos.fopRows.upsertMany(session.id, parsed.rows);
    const groups = new Map<string, FopImportResult['accounts'][number]>();
    for (const row of parsed.rows) {
      const key = `${row.account}:${row.currency}`;
      const have = groups.get(key);
      if (!have) {
        groups.set(key, {
          account: row.account,
          currency: row.currency,
          from: row.day,
          to: row.day,
          rows: 1,
        });
      } else {
        have.rows += 1;
        if (row.day < have.from) have.from = row.day;
        if (row.day > have.to) have.to = row.day;
      }
    }
    return {
      period: parsed.period,
      rows: {
        read: parsed.rows.length,
        added,
        updated: parsed.rows.length - added,
        skipped: parsed.skipped,
      },
      accounts: [...groups.values()],
      notes: parsed.notes,
    };
  }

  report(session: SessionRecord, year: string | undefined, rate: FopRate): FopReport {
    return buildFopReport(this.core.repos.fopRows.list(session.id), {
      year,
      singleTaxPercent: rate,
      today: this.calendar.today(this.core.clock.now()),
    });
  }

  /** `counted` true or false is the person's decision; null goes back to what the report decides. */
  setCounted(session: SessionRecord, id: string, counted: boolean | null): void {
    if (!this.core.repos.fopRows.setOverride(session.id, id, counted))
      throw notFound('Statement row');
  }

  clear(session: SessionRecord): void {
    this.core.repos.fopRows.deleteAll(session.id);
  }
}
