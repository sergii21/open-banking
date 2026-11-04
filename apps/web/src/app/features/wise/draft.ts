import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import {
  parseAmountToMinor,
  type WiseDraftCreated,
  type WiseDraftOverview,
  type WiseDraftQuote,
} from '@ledger-lens/contracts';
import { Api, ApiError } from '../../core/api';
import { timeOfDay } from '../../core/format';
import { Ui } from '../../core/ui';
import { Amount } from '../../shared/amount';
import { Sheet } from '../../shared/sheet';

const message = (error: unknown): string =>
  error instanceof ApiError ? error.message : 'That did not work. Try again.';

/**
 * Drafting a Wise transfer: choose a balance, a saved recipient and an amount, see Wise's price, create it unpaid. The person pays it
 * in Wise; nothing in this app can. Loaded when first opened, so it costs the first load nothing.
 */
@Component({
  selector: 'll-wise-draft',
  imports: [Amount, Sheet],
  templateUrl: './draft.html',
})
export class WiseDraft {
  private readonly api = inject(Api);
  protected readonly ui = inject(Ui);

  protected readonly step = signal<'form' | 'review' | 'done'>('form');
  protected readonly overview = signal<WiseDraftOverview | null>(null);
  protected readonly loading = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly accountId = signal('');
  protected readonly recipientId = signal('');
  protected readonly amount = signal('');
  protected readonly reference = signal('');
  protected readonly quote = signal<WiseDraftQuote | null>(null);
  protected readonly created = signal<WiseDraftCreated | null>(null);

  protected readonly source = computed(
    () => this.overview()?.sources.find((s) => s.accountId === this.accountId()) ?? null,
  );
  protected readonly recipient = computed(
    () => this.overview()?.recipients.find((r) => String(r.id) === this.recipientId()) ?? null,
  );
  private readonly amountMinor = computed(() => {
    const source = this.source();
    return source ? parseAmountToMinor(this.amount(), source.currency) : null;
  });
  protected readonly amountInvalid = computed(
    () => this.amount().trim() !== '' && this.amountMinor() === null,
  );
  /** Not a refusal: the person can pay a draft another way in Wise. It is only worth saying. */
  protected readonly overBalance = computed(() => {
    const minor = this.amountMinor();
    const source = this.source();
    return minor !== null && source !== null && minor > source.balanceMinor;
  });
  protected readonly canPrice = computed(
    () => this.amountMinor() !== null && this.recipient() !== null && !this.busy(),
  );
  protected readonly holdsUntil = computed(() => {
    const at = Date.parse(this.quote()?.expiresAt ?? '');
    return Number.isNaN(at) ? null : timeOfDay(at);
  });

  constructor() {
    // Opening starts clean and reads Wise once, not when the sheet is merely on the page.
    effect(() => {
      if (!this.ui.wiseDraft()) return;
      untracked(() => {
        this.reset();
        void this.load();
      });
    });
  }

  private reset(): void {
    this.step.set('form');
    this.recipientId.set('');
    this.amount.set('');
    this.reference.set('');
    this.quote.set(null);
    this.created.set(null);
    this.error.set(null);
  }

  private async load(accountId?: string): Promise<void> {
    this.loading.set(true);
    try {
      const query = accountId ? `?accountId=${encodeURIComponent(accountId)}` : '';
      const overview = await this.api.request<WiseDraftOverview>('GET', `/api/wise/drafts${query}`);
      this.overview.set(overview);
      this.accountId.set(overview.accountId);
      if (!overview.recipients.some((r) => String(r.id) === this.recipientId())) {
        this.recipientId.set('');
      }
    } catch (error) {
      this.error.set(message(error));
    } finally {
      this.loading.set(false);
    }
  }

  /** Balances of one Wise profile share their recipients, so only a change of profile reads Wise again. */
  protected chooseSource(accountId: string): void {
    const before = this.source();
    this.accountId.set(accountId);
    this.error.set(null);
    if (before?.group !== this.source()?.group) void this.load(accountId);
  }

  protected async price(): Promise<void> {
    const minor = this.amountMinor();
    const recipient = this.recipient();
    if (minor === null || !recipient) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      this.quote.set(
        await this.api.request<WiseDraftQuote>('POST', '/api/wise/drafts/quote', {
          accountId: this.accountId(),
          recipientId: recipient.id,
          targetCurrency: recipient.currency,
          amountMinor: minor,
        }),
      );
      this.step.set('review');
    } catch (error) {
      this.error.set(message(error));
    } finally {
      this.busy.set(false);
    }
  }

  /** The quote carries a key: pressing again after a timeout never creates a second transfer. */
  protected async create(): Promise<void> {
    const quote = this.quote();
    const recipient = this.recipient();
    if (!quote || !recipient) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const reference = this.reference().trim();
      this.created.set(
        await this.api.request<WiseDraftCreated>('POST', '/api/wise/drafts', {
          accountId: this.accountId(),
          recipientId: recipient.id,
          quoteId: quote.quoteId,
          draftKey: quote.draftKey,
          ...(reference ? { reference } : {}),
        }),
      );
      this.step.set('done');
      void this.load(this.accountId());
    } catch (error) {
      this.error.set(message(error));
    } finally {
      this.busy.set(false);
    }
  }

  protected back(): void {
    this.quote.set(null);
    this.error.set(null);
    this.step.set('form');
  }

  protected another(): void {
    this.reset();
  }
}
