import { Component, computed, inject, signal } from '@angular/core';
import { ApiError } from '../../core/api';
import { countdown } from '../../core/format';
import { Nav } from '../../core/nav';
import { Session, type TokenBank } from '../../core/session';
import { Ticker } from '../../core/ticker';
import { Ui } from '../../core/ui';
import { Icon } from '../../shared/icon';

type Source = TokenBank | 'privat24';

const SOURCES: { id: Source; label: string }[] = [
  { id: 'monobank', label: 'monobank' },
  { id: 'privatbank', label: 'PrivatBank' },
  { id: 'privat24', label: 'Privat24 file' },
];

/** 5 MB: more than years of one person's card statements, and the most the server reads. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** The first-run screen, and the same screen again as "Add a bank" once something is connected. */
@Component({
  selector: 'll-welcome',
  imports: [Icon],
  templateUrl: './welcome.html',
})
export class Welcome {
  protected readonly session = inject(Session);
  private readonly nav = inject(Nav);
  private readonly ui = inject(Ui);
  private readonly ticker = inject(Ticker);

  protected readonly sources = SOURCES;
  protected readonly adding = computed(() => this.session.connected());
  protected readonly source = signal<Source>(
    ((): Source => {
      const wanted = this.nav.query().get('source');
      return wanted === 'privatbank' || wanted === 'privat24' ? wanted : 'monobank';
    })(),
  );
  protected readonly bank = computed(() =>
    this.source() === 'privatbank' ? 'PrivatBank' : 'monobank',
  );

  protected readonly token = signal('');
  protected readonly shown = signal(false);
  protected readonly busy = signal<'token' | 'demo' | 'file' | null>(null);
  protected readonly error = signal<string | null>(null);
  private readonly retryAt = signal<number | null>(null);
  protected readonly wait = computed(() => {
    const at = this.retryAt();
    return at === null ? 0 : Math.max(0, at - this.ticker.now());
  });
  protected readonly waitText = computed(() => countdown(this.wait()));

  protected pick(source: Source): void {
    this.source.set(source);
    this.error.set(null);
    this.token.set('');
    this.retryAt.set(null);
  }

  protected async connect(): Promise<void> {
    const source = this.source();
    if (source === 'privat24' || !this.token().trim() || this.busy() || this.wait() > 0) return;
    this.busy.set('token');
    this.error.set(null);
    try {
      await this.session.connectToken(source, this.token());
      this.token.set('');
      await this.nav.go('/home', true);
    } catch (error) {
      this.explain(error);
    } finally {
      this.busy.set(null);
    }
  }

  protected async importFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file || this.busy()) return;
    if (file.size > MAX_FILE_BYTES) {
      this.error.set(
        'That file is larger than 5 MB, so it is not a card statement. Choose the statement itself.',
      );
      return;
    }
    this.busy.set('file');
    this.error.set(null);
    try {
      this.ui.imported.set(await this.session.importPrivat24(await file.arrayBuffer()));
      await this.nav.go('/home', true);
    } catch (error) {
      this.explain(error);
    } finally {
      this.busy.set(null);
    }
  }

  protected async demo(): Promise<void> {
    if (this.busy()) return;
    this.busy.set('demo');
    this.error.set(null);
    try {
      await this.session.connectDemo();
      await this.nav.go('/home', true);
    } catch (error) {
      this.explain(error);
    } finally {
      this.busy.set(null);
    }
  }

  private explain(error: unknown): void {
    if (!(error instanceof ApiError)) {
      this.error.set('Something went wrong. Try again.');
      return;
    }
    if (error.offline) {
      this.error.set(
        'Ledger Lens is not running. Start it again with ./start.sh and reload this page.',
      );
    } else if (error.code === 'rate_limited') {
      this.retryAt.set(Date.now() + (error.retryAfterSeconds ?? 60) * 1000);
      this.error.set(
        this.source() === 'monobank'
          ? 'monobank allows one check a minute, and one was just made.'
          : 'Too many tries in a row.',
      );
    } else if (error.code === 'bank_unavailable') {
      this.error.set(`${this.bank()} is not responding right now. Try again in a minute.`);
    } else if (error.code === 'unsupported_file') {
      // The whole sentence: it lists the column titles the file had.
      this.error.set(error.message);
    } else {
      this.error.set(error.fields[0]?.message ?? error.message);
    }
  }
}
