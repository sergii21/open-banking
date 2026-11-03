import {
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import {
  CATEGORIES,
  csvNumber,
  csvText,
  formatMoney,
  minorToDecimalString,
  toCsv,
  type Account,
  type ActivityRow,
  type Category,
} from '@ledger-lens/contracts';
import { Api } from '../../core/api';
import { dayKey, dayLabel, longDate, timeOfDay } from '../../core/format';
import { Live } from '../../core/live';
import { Nav } from '../../core/nav';
import { Session } from '../../core/session';
import { Stores } from '../../core/stores';
import { SyncActions } from '../../core/sync';
import { Toast } from '../../core/toast';
import { Ui } from '../../core/ui';
import { Amount } from '../../shared/amount';
import { CATEGORY_LABEL } from '../../shared/categories';
import { Clipboard } from '../../shared/copy';
import { categoryIcon, Icon } from '../../shared/icon';
import { Sheet } from '../../shared/sheet';

interface RowView {
  row: ActivityRow;
  /** Everything a person might type to find it, lower-cased once. */
  hay: string;
  day: string;
  account: Account | undefined;
}

interface DayGroup {
  key: string;
  label: string;
  rows: RowView[];
  /** Net movement of the day when every row is in one currency. */
  net: { minor: number; currency: string } | null;
}

type Scope = 'all' | 'spending' | 'income' | 'month';
const PAGE = 100;
const HIDDEN_FROM_SPENDING: ReadonlySet<Category> = new Set<Category>(['transfers', 'income']);

/** "450", "450,5" or "1 234.50" as minor units, or null for anything else. */
function parseAmount(text: string): number | null {
  const cleaned = text.replace(/[\s\u00a0]/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

@Component({
  selector: 'll-activity',
  imports: [Amount, Icon, Sheet],
  templateUrl: './activity.html',
  host: { '(window:click)': 'onWindowClick($event)' },
})
export class Activity {
  private readonly api = inject(Api);
  protected readonly stores = inject(Stores);
  protected readonly session = inject(Session);
  protected readonly live = inject(Live);
  protected readonly ui = inject(Ui);
  protected readonly actions = inject(SyncActions);
  private readonly toast = inject(Toast);
  protected readonly clipboard = inject(Clipboard);

  private readonly nav = inject(Nav);

  protected readonly data = this.stores.activity.data;
  protected readonly categories = CATEGORIES;
  protected readonly labelOf = CATEGORY_LABEL;
  protected readonly categoryIcon = categoryIcon;
  protected readonly skeletonRows = Array.from({ length: 9 }, (_, i) => i);

  // The filters: all in the browser, so a keystroke is a filter and nothing waits on the server.
  protected readonly q = signal('');
  protected readonly scope = signal<Scope>('all');
  protected readonly account = signal<string | null>(null);
  protected readonly category = signal<Category | ''>('');
  protected readonly min = signal('');
  protected readonly max = signal('');
  protected readonly from = signal('');
  protected readonly to = signal('');
  protected readonly moreOpen = signal(false);
  protected readonly detail = signal<RowView | null>(null);
  protected readonly detailOpen = signal(false);

  private readonly search = viewChild<ElementRef<HTMLInputElement>>('search');
  private readonly sentinel = viewChild<ElementRef<HTMLElement>>('sentinel');
  private handledFocus = this.ui.focusSearch();

  protected readonly accounts = computed(() => this.data()?.accounts ?? []);
  private readonly accountById = computed(() => new Map(this.accounts().map((a) => [a.id, a])));

  protected readonly views = computed<RowView[]>(() => {
    const accounts = this.accountById();
    return (this.data()?.rows ?? []).map((row) => {
      const major = minorToDecimalString(Math.abs(row.amountMinor), row.currency);
      return {
        row,
        day: dayKey(row.ts),
        account: accounts.get(row.accountId),
        hay: `${row.description} ${row.counterparty ?? ''} ${row.comment ?? ''} ${CATEGORY_LABEL[row.category]} ${major} ${major.replace('.', ',')}`.toLowerCase(),
      };
    });
  });

  protected readonly activeFilters = computed(
    () =>
      (this.category() ? 1 : 0) +
      (this.min() || this.max() ? 1 : 0) +
      (this.from() || this.to() ? 1 : 0),
  );

  protected readonly filtered = computed(() => {
    const needle = this.q().trim().toLowerCase();
    const scope = this.scope();
    const account = this.account();
    const category = this.category();
    const min = parseAmount(this.min());
    const max = parseAmount(this.max());
    const from = this.from();
    const to = this.to();
    const month = dayKey(Date.now()).slice(0, 7);
    return this.views().filter(({ row, hay, day }) => {
      if (account && row.accountId !== account) return false;
      if (needle && !hay.includes(needle)) return false;
      if (scope === 'spending' && (row.amountMinor >= 0 || HIDDEN_FROM_SPENDING.has(row.category)))
        return false;
      if (scope === 'income' && row.amountMinor <= 0) return false;
      if (scope === 'month' && !day.startsWith(month)) return false;
      if (category && row.category !== category) return false;
      const size = Math.abs(row.amountMinor);
      if (min !== null && size < min) return false;
      if (max !== null && size > max) return false;
      if (from && day < from) return false;
      if (to && day > to) return false;
      return true;
    });
  });

  private readonly limit = linkedSignal<unknown, number>({
    source: this.filtered,
    computation: () => PAGE,
  });
  protected readonly hasMore = computed(() => this.filtered().length > this.limit());

  protected readonly groups = computed<DayGroup[]>(() => {
    const today = dayKey(Date.now());
    const groups: DayGroup[] = [];
    for (const view of this.filtered().slice(0, this.limit())) {
      let group = groups.at(-1);
      if (group?.key !== view.day) {
        group = { key: view.day, label: dayLabel(view.day, today), rows: [], net: null };
        groups.push(group);
      }
      group.rows.push(view);
    }
    for (const group of groups) {
      const currency = group.rows[0]?.row.currency;
      if (currency && group.rows.every((v) => v.row.currency === currency)) {
        group.net = { minor: group.rows.reduce((sum, v) => sum + v.row.amountMinor, 0), currency };
      }
    }
    return groups;
  });

  protected readonly summary = computed(() => {
    const count = this.filtered().length;
    const total = this.views().length;
    return count === total
      ? `${total.toLocaleString('en-GB')} transactions`
      : `${count.toLocaleString('en-GB')} of ${total.toLocaleString('en-GB')}`;
  });

  protected readonly selectedAccount = computed(() => {
    const id = this.account();
    return id ? this.accountById().get(id) : undefined;
  });

  protected readonly filtering = computed(
    () =>
      this.q().trim() !== '' ||
      this.scope() !== 'all' ||
      this.account() !== null ||
      this.activeFilters() > 0,
  );

  constructor() {
    this.stores.activity.ensure();
    // `?card=<id>` from a tile on Home.
    effect(() => {
      this.account.set(this.nav.query().get('card'));
    });
    effect(() => {
      const bump = this.ui.focusSearch();
      if (bump !== this.handledFocus) {
        this.handledFocus = bump;
        this.search()?.nativeElement.focus();
      }
    });
    effect((onCleanup) => {
      const element = this.sentinel()?.nativeElement;
      if (!element) return;
      const observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) this.limit.update((n) => n + PAGE);
        },
        { rootMargin: '800px' },
      );
      observer.observe(element);
      onCleanup(() => observer.disconnect());
    });
  }

  protected title(view: RowView): string {
    return view.row.counterparty ?? view.row.description;
  }

  protected cardLabel(view: RowView): string {
    const account = view.account;
    if (!account) return 'Unknown';
    return account.last4 ? `${account.name} ••${account.last4}` : account.name;
  }

  protected subtitle(view: RowView): string {
    const parts: string[] = [CATEGORY_LABEL[view.row.category]];
    if (view.account)
      parts.push(view.account.last4 ? `••${view.account.last4}` : view.account.name);
    parts.push(timeOfDay(view.row.ts));
    return parts.join(' · ');
  }

  protected setScope(scope: Scope): void {
    this.scope.set(this.scope() === scope && scope !== 'all' ? 'all' : scope);
  }

  protected setAccount(id: string | null): void {
    this.account.set(this.account() === id ? null : id);
  }

  protected clearAll(): void {
    this.q.set('');
    this.scope.set('all');
    this.account.set(null);
    this.category.set('');
    this.min.set('');
    this.max.set('');
    this.from.set('');
    this.to.set('');
  }

  protected clearMore(): void {
    this.category.set('');
    this.min.set('');
    this.max.set('');
    this.from.set('');
    this.to.set('');
  }

  protected onWindowClick(event: Event): void {
    if (this.moreOpen() && !(event.target as HTMLElement).closest('.popover, .more-btn')) {
      this.moreOpen.set(false);
    }
  }

  protected open(view: RowView): void {
    this.detail.set(view);
    this.detailOpen.set(true);
  }

  protected async changeCategory(view: RowView, category: Category): Promise<void> {
    if (category === view.row.category) return;
    try {
      await this.api.patch(`/api/transactions/${view.row.id}`, { category });
      this.stores.activity.data.update((activity) =>
        activity
          ? {
              ...activity,
              rows: activity.rows.map((r) =>
                r.id === view.row.id ? { ...r, category, chosen: true as const } : r,
              ),
            }
          : activity,
      );
      const changed = this.views().find((v) => v.row.id === view.row.id);
      if (changed) this.detail.set(changed);
      this.toast.show(`Moved to ${CATEGORY_LABEL[category]}. It stays there after refreshes.`);
      setTimeout(() => this.stores.refreshLoaded(), 300);
    } catch {
      this.toast.show('Could not change the category. Try again.');
    }
  }

  protected exportCsv(): void {
    const rows = this.filtered().map(({ row, account }) => {
      const date = new Date(row.ts);
      return [
        csvText(dayKey(row.ts)),
        csvText(timeOfDay(row.ts)),
        csvText(account ? `${account.name}${account.last4 ? ` ${account.last4}` : ''}` : ''),
        csvText(row.description),
        csvText(row.counterparty ?? ''),
        csvText(row.comment ?? ''),
        csvText(CATEGORY_LABEL[row.category]),
        csvNumber(minorToDecimalString(row.amountMinor, row.currency)),
        csvText(row.currency),
        csvText(row.status === 'pending' ? 'pending' : 'booked'),
        csvNumber(row.mcc ? String(row.mcc) : ''),
        csvNumber(minorToDecimalString(row.cashbackMinor ?? 0, row.currency)),
        csvNumber(minorToDecimalString(row.commissionMinor ?? 0, row.currency)),
        csvNumber(
          row.balanceAfterMinor === undefined
            ? ''
            : minorToDecimalString(row.balanceAfterMinor, row.currency),
        ),
        csvText(date.toISOString()),
      ];
    });
    const csv = toCsv(
      [
        'Date',
        'Time',
        'Card',
        'Description',
        'Counterparty',
        'Comment',
        'Category',
        'Amount',
        'Currency',
        'Status',
        'MCC',
        'Cashback',
        'Commission',
        'Balance after',
        'UTC timestamp',
      ],
      rows,
    );
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `ledger-lens-${dayKey(Date.now())}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    this.toast.show(`${rows.length.toLocaleString('en-GB')} transactions exported`);
  }

  protected money(minor: number, currency: string): string {
    return formatMoney(minor, currency);
  }
  protected longDate = longDate;
  protected time = timeOfDay;
}
