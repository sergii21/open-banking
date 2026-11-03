import { Component, computed, inject } from '@angular/core';
import { formatMoney } from '@ledger-lens/contracts';
import { monthLabel, shortDate } from '../../core/format';
import { Stores } from '../../core/stores';
import { Amount } from '../../shared/amount';
import { CATEGORY_LABEL } from '../../shared/categories';
import { categoryIcon, Icon } from '../../shared/icon';

const CADENCE: Record<string, string> = { weekly: 'Every week', monthly: 'Every month', quarterly: 'Every 3 months', yearly: 'Every year' };

@Component({
  selector: 'll-insights',
  imports: [Amount, Icon],
  templateUrl: './insights.html',
})
export class Insights {
  protected readonly stores = inject(Stores);
  protected readonly data = this.stores.insights.data;
  protected readonly labelOf = CATEGORY_LABEL;
  protected readonly categoryIcon = categoryIcon;
  protected readonly cadence = CADENCE;
  protected readonly shortDate = shortDate;
  protected readonly monthLabel = monthLabel;

  protected readonly months = computed(() => this.data()?.months ?? []);
  protected readonly index = computed(() => this.months().indexOf(this.data()?.month ?? ''));
  protected readonly hasOlder = computed(() => this.index() >= 0 && this.index() < this.months().length - 1);
  protected readonly hasNewer = computed(() => this.index() > 0);
  protected readonly maxCategory = computed(() => Math.max(1, ...(this.data()?.categories ?? []).map((c) => c.spentMinor)));
  protected readonly maxMerchant = computed(() => Math.max(1, ...(this.data()?.merchants ?? []).map((m) => m.spentMinor)));
  protected readonly skeleton = [1, 2, 3];

  protected readonly change = computed(() => {
    const d = this.data();
    if (!d || d.previousSpentMinor === null) return null;
    if (d.previousSpentMinor === 0) return { text: 'Nothing spent the month before', tone: 'plain' };
    const pct = Math.round(((d.spentMinor - d.previousSpentMinor) / d.previousSpentMinor) * 100);
    const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
    const earlier = monthLabel(this.months()[this.index() + 1] ?? d.month).split(' ')[0];
    return { text: `${sign}${Math.abs(pct)}% vs ${d.previousIsSameDays ? 'same days in ' : ''}${earlier}`, tone: pct <= 0 ? 'good' : 'plain' };
  });

  constructor() {
    this.stores.insights.ensure();
  }

  protected step(direction: 'older' | 'newer'): void {
    const next = this.months()[this.index() + (direction === 'older' ? 1 : -1)];
    if (!next) return;
    this.stores.insightsMonth.set(next);
    void this.stores.insights.reload();
  }

  protected categoryChange(category: { spentMinor: number; previousMinor: number | null }): string | null {
    if (category.previousMinor === null) return null;
    const diff = category.spentMinor - category.previousMinor;
    const than = this.data()?.previousIsSameDays ? 'the same days last month' : 'the month before';
    if (diff === 0) return `Same as ${than}`;
    return `${formatMoney(Math.abs(diff), 'UAH', { fraction: false })} ${diff > 0 ? 'more' : 'less'} than ${than}`;
  }
}
