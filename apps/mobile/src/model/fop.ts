import type { FopImportResult, FopRate, FopReport } from '@ledger-lens/contracts';
import type { Calendar } from '@api/domain/calendar';
import { readCsv } from '@api/domain/files/csv';
import { buildFopReport } from '@api/domain/fop-report';
import { StatementError } from '@api/domain/privat24-statement';
import { parseUkrsibStatement } from '@api/domain/ukrsib-statement';
import type { Store } from '../data/db';

/** A file the reader refused, in words for the person: the column titles it found and none of its values. */
export class FopFileError extends Error {
  override name = 'FopFileError';
}

/**
 * Reads one UKRSIB business statement (CSV) the person picked, with the server's own reader, and keeps its rows on the
 * phone. The bytes are parsed in memory and dropped. Nothing is sent anywhere: this never touches the network.
 */
export async function importUkrsib(
  store: Store,
  calendar: Calendar,
  bytes: Uint8Array,
): Promise<FopImportResult> {
  let parsed;
  try {
    // The reader is typed for Node's Buffer and uses only what every byte array has.
    parsed = parseUkrsibStatement(readCsv(bytes as Buffer), calendar);
  } catch (error) {
    if (!(error instanceof StatementError)) throw error;
    throw new FopFileError(
      error.headers.length > 0
        ? `${error.message} Columns found: ${error.headers.join(' · ')}.`
        : `${error.message} No column titles were found.`,
    );
  }
  const added = await store.upsertFopRows(parsed.rows);
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

export async function fopReport(
  store: Store,
  today: string,
  year: string | undefined,
  rate: FopRate,
): Promise<FopReport> {
  return buildFopReport(await store.fopRows(), { year, singleTaxPercent: rate, today });
}

/** `3402992.73`: the way a number is typed into the tax cabinet. Built from integer kopiykas, never a float. */
export function cabinetNumber(amountMinor: number): string {
  const sign = amountMinor < 0 ? '-' : '';
  const abs = Math.abs(amountMinor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-05-10` as `10 May 2026`, without the machine's time zone having a say. */
export function dayText(day: string): string {
  const [year = '', month = '1', dom = '1'] = day.split('-');
  return `${Number(dom)} ${MONTHS[Number(month) - 1] ?? ''} ${year}`;
}
