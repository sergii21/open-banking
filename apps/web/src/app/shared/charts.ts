import { Component, computed, input } from '@angular/core';
import { formatMoney } from '@ledger-lens/contracts';
import { shortDate } from '../core/format';

const W = 300;
const H = 92;

/** A smooth line through the points (Catmull-Rom turned into Bezier segments). */
function smooth(xs: number[], ys: number[]): string {
  let d = `M${xs[0]?.toFixed(2)} ${ys[0]?.toFixed(2)}`;
  for (let i = 0; i < xs.length - 1; i += 1) {
    const x0 = xs[i - 1] ?? xs[i] ?? 0;
    const y0 = ys[i - 1] ?? ys[i] ?? 0;
    const x1 = xs[i] ?? 0;
    const y1 = ys[i] ?? 0;
    const x2 = xs[i + 1] ?? 0;
    const y2 = ys[i + 1] ?? 0;
    const x3 = xs[i + 2] ?? x2;
    const y3 = ys[i + 2] ?? y2;
    const c1x = x1 + (x2 - x0) / 6;
    const c1y = y1 + (y2 - y0) / 6;
    const c2x = x2 - (x3 - x1) / 6;
    const c2y = y2 - (y3 - y1) / 6;
    d += ` C${c1x.toFixed(2)} ${c1y.toFixed(2)} ${c2x.toFixed(2)} ${c2y.toFixed(2)} ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  }
  return d;
}

/** The 30-day line on the hero card: white on the gradient, an area under it, a dot where today is. */
@Component({
  selector: 'll-sparkline',
  template: `
    <svg
      class="hero-chart"
      [attr.viewBox]="'0 0 ' + w + ' ' + h"
      preserveAspectRatio="none"
      role="img"
      [attr.aria-label]="label()"
    >
      <path [attr.d]="area()" fill="rgb(255 255 255 / 0.16)" />
      <path
        [attr.d]="line()"
        fill="none"
        stroke="#fff"
        stroke-width="2.4"
        stroke-linecap="round"
        stroke-linejoin="round"
        vector-effect="non-scaling-stroke"
      />
    </svg>
    <span class="spark-dot" [style.top.%]="dotTop()"></span>
  `,
  host: { style: 'display:block;position:relative' },
})
export class Sparkline {
  readonly points = input.required<readonly number[]>();
  readonly from = input.required<string>();
  protected readonly w = W;
  protected readonly h = H;

  private readonly coords = computed(() => {
    const points = this.points();
    const min = Math.min(...points);
    const max = Math.max(...points);
    const span = max - min || 1;
    const xs = points.map((_, i) => (i / Math.max(1, points.length - 1)) * W);
    const ys = points.map((p) => 10 + (1 - (p - min) / span) * (H - 22));
    return { xs, ys };
  });
  protected readonly line = computed(() => smooth(this.coords().xs, this.coords().ys));
  protected readonly area = computed(() => `${this.line()} L${W} ${H} L0 ${H} Z`);
  protected readonly dotTop = computed(() => ((this.coords().ys.at(-1) ?? 0) / H) * 100);
  protected readonly label = computed(() => {
    const p = this.points();
    return `Own money over the last 30 days, from ${formatMoney(p[0] ?? 0, 'UAH', { fraction: false })} on ${shortDate(this.from())} to ${formatMoney(p.at(-1) ?? 0, 'UAH', { fraction: false })} today`;
  });
}

/** One bar per day of the month; the days still to come are drawn pale. */
@Component({
  selector: 'll-daily-bars',
  template: `
    <svg
      class="bars"
      [attr.viewBox]="'0 0 ' + values().length + ' 100'"
      preserveAspectRatio="none"
      role="img"
      [attr.aria-label]="label()"
    >
      <line x1="0" y1="99.5" [attr.x2]="values().length" y2="99.5" />
      @for (v of bars(); track $index) {
        <rect
          [attr.x]="$index + 0.17"
          [attr.y]="100 - v.h"
          width="0.66"
          [attr.height]="v.h"
          rx="0.24"
          ry="2.5"
          [attr.data-future]="v.future ? '' : null"
          [attr.data-today]="v.today ? '' : null"
        >
          <title>{{ v.title }}</title>
        </rect>
      }
    </svg>
    <div class="axis" aria-hidden="true">
      <span>1</span><span>{{ values().length }}</span>
    </div>
  `,
})
export class DailyBars {
  readonly values = input.required<readonly number[]>();
  /** Day of the month today is (1-based). */
  readonly today = input.required<number>();
  readonly month = input.required<string>();

  protected readonly bars = computed(() => {
    const values = this.values();
    const max = Math.max(1, ...values);
    return values.map((value, i) => ({
      h: value > 0 ? Math.max(4, (value / max) * 94) : 1.5,
      future: i + 1 > this.today(),
      today: i + 1 === this.today(),
      title: `${shortDate(`${this.month()}-${String(i + 1).padStart(2, '0')}`)}: ${i + 1 > this.today() ? 'to come' : formatMoney(value, 'UAH', { fraction: false })}`,
    }));
  });
  protected readonly label = computed(() => {
    const values = this.values().slice(0, this.today());
    const top = Math.max(0, ...values);
    return `Spending per day this month, the busiest day ${formatMoney(top, 'UAH', { fraction: false })}`;
  });
}
