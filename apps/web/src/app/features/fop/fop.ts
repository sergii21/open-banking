import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import {
  FOP_RATES,
  minorToDecimalString,
  type FopImportResult,
  type FopPeriod,
  type FopRate,
  type FopReport,
  type FopRow,
} from '@ledger-lens/contracts';
import { Api, ApiError } from '../../core/api';
import { Prefs } from '../../core/prefs';
import { Ui } from '../../core/ui';
import { Amount } from '../../shared/amount';
import { Clipboard } from '../../shared/copy';
import { Sheet } from '../../shared/sheet';

const MAX_FILE_BYTES = 5 * 1024 * 1024;

type Filter = 'all' | 'counted' | 'left-out' | 'tax';

const dayText = (day: string): string => `${day.slice(8)}.${day.slice(5, 7)}.${day.slice(0, 4)}`;

/**
 * The ФОП report: income read from UKRSIB business statements the person imports (CSV), per quarter, with the single tax and the
 * military levy worked out from it. It files nothing and decides nothing for the person: every row can be counted or left out,
 * and the rates are assumptions the sheet says so about. Loaded when first opened.
 */
@Component({
  selector: 'll-fop',
  imports: [Amount, Sheet],
  templateUrl: './fop.html',
})
export class Fop {
  private readonly api = inject(Api);
  private readonly prefs = inject(Prefs);
  protected readonly ui = inject(Ui);
  private readonly clipboard = inject(Clipboard);

  protected readonly rates = FOP_RATES;
  protected readonly dayText = dayText;
  protected readonly report = signal<FopReport | null>(null);
  protected readonly loading = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly imported = signal<string[]>([]);
  protected readonly filter = signal<Filter>('all');
  protected readonly confirmClear = signal(false);
  protected readonly year = signal<string | undefined>(undefined);
  protected readonly rate = this.prefs.fopRate;

  protected readonly rows = computed<FopRow[]>(() => {
    const all = this.report()?.rows ?? [];
    switch (this.filter()) {
      case 'counted':
        return all.filter((r) => r.counted);
      case 'left-out':
        return all.filter((r) => r.direction === 'in' && !r.counted);
      case 'tax':
        return all.filter((r) => r.direction === 'out');
      default:
        return all;
    }
  });
  protected readonly countedRows = computed(
    () => (this.report()?.rows ?? []).filter((r) => r.counted).length,
  );

  constructor() {
    effect(() => {
      if (!this.ui.fop()) return;
      untracked(() => {
        this.confirmClear.set(false);
        void this.load();
      });
    });
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    try {
      const year = this.year();
      const query = new URLSearchParams({ rate: String(this.rate()) });
      if (year) query.set('year', year);
      this.report.set(await this.api.get<FopReport>(`/api/fop?${query.toString()}`));
    } catch (error) {
      this.error.set(this.explain(error));
    } finally {
      this.loading.set(false);
    }
  }

  protected setYear(year: string): void {
    this.year.set(year);
    void this.load();
  }

  protected setRate(rate: FopRate): void {
    this.prefs.setFopRate(rate);
    void this.load();
  }

  protected async importFiles(input: HTMLInputElement): Promise<void> {
    const files = [...(input.files ?? [])];
    input.value = '';
    if (files.length === 0 || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    const lines: string[] = [];
    try {
      for (const file of files) {
        if (file.size > MAX_FILE_BYTES) {
          this.error.set(
            'That file is larger than 5 MB, so it is not a statement. Choose the statement itself.',
          );
          break;
        }
        const result = await this.api.upload<FopImportResult>(
          '/api/imports/ukrsib',
          await file.arrayBuffer(),
        );
        const accounts = result.accounts
          .map((a) => `${a.currency} ····${a.account}, ${dayText(a.from)} to ${dayText(a.to)}`)
          .join('; ');
        lines.push(
          `Read ${result.rows.read} rows (${result.rows.added} new, ${result.rows.updated} already here): ${accounts}.`,
          ...result.notes,
        );
      }
      this.imported.set(lines);
      this.year.set(undefined);
      await this.load();
    } catch (error) {
      this.imported.set(lines);
      this.error.set(this.explain(error));
    } finally {
      this.busy.set(false);
    }
  }

  protected async decide(row: FopRow, counted: boolean | null): Promise<void> {
    this.error.set(null);
    try {
      await this.api.patch(`/api/fop/rows/${row.id}`, { counted });
      await this.load();
    } catch (error) {
      this.error.set(this.explain(error));
    }
  }

  protected async clear(): Promise<void> {
    if (!this.confirmClear()) {
      this.confirmClear.set(true);
      return;
    }
    this.confirmClear.set(false);
    try {
      await this.api.delete('/api/fop');
      this.imported.set([]);
      this.year.set(undefined);
      await this.load();
    } catch (error) {
      this.error.set(this.explain(error));
    }
  }

  /** The amount the way the form takes it: 3402992.73. */
  protected plain(minor: number): string {
    return minorToDecimalString(minor, 'UAH');
  }

  protected copyLine(code: string, minor: number): void {
    void this.clipboard.copy(this.plain(minor), `Line ${code}`);
  }

  /** What the quarter's payment looks like next to what the statements say was paid: in words, never colour alone. */
  protected check(due: number, paid: number): string {
    if (paid === 0) return 'Not paid yet';
    if (paid === due) return 'Matches';
    return paid > due ? 'Paid more' : 'Paid less';
  }

  protected title(period: FopPeriod): string {
    return `Quarter ${period.quarter}`;
  }

  protected status(row: FopRow): string {
    if (row.direction === 'out') return 'Paid';
    return row.counted ? 'Counted' : 'Not counted';
  }

  private explain(error: unknown): string {
    if (!(error instanceof ApiError)) return 'That did not work. Try again.';
    if (error.offline) {
      return 'Ledger Lens is not running. Start it again with ./start.sh and reload this page.';
    }
    return error.message;
  }
}
