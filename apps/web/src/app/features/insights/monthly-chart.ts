import { DOCUMENT } from '@angular/common';
import { Component, computed, inject, input, signal } from '@angular/core';
import { currencyExponent, type MonthlyFlow } from '@ledger-lens/contracts';
import type { ApexOptions } from 'apexcharts';
import { ChartComponent } from 'ng-apexcharts';
import { ThemeService } from '../../core/theme/theme';
import { formatMoney } from '../../shared/format';
import { Money } from '../../shared/money/money';
import { Segmented, type SegmentOption } from '../../shared/segmented/segmented';
import { readInk, SERIES_COLORS } from './chart-theme';
import { describeMonths, monthLabels, monthName } from './insights-view';

type View = 'chart' | 'table';

const VIEWS: readonly SegmentOption<View>[] = [
  { value: 'chart', label: 'Chart' },
  { value: 'table', label: 'Table' },
];

const COMPACT = new Intl.NumberFormat('en-GB', { notation: 'compact', maximumFractionDigits: 1 });

const prefersReducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Income against spending, month by month: two series, so a legend, a hover readout for both at once, and a table view
 * that carries every value without hovering (the chart is for the shape, the table is for the numbers and for anyone who
 * cannot see the chart). Columns are thin, rounded at the top only, and separated by a 2px gap in the surface colour.
 */
@Component({
  selector: 'll-monthly-chart',
  imports: [ChartComponent, Money, Segmented],
  template: `
    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <ul class="m-0 flex list-none items-center gap-4 p-0 text-sm" data-testid="chart-legend">
        <li class="flex items-center gap-2">
          <span class="size-3 rounded-sm bg-series-1" aria-hidden="true"></span>
          Income
        </li>
        <li class="flex items-center gap-2">
          <span class="size-3 rounded-sm bg-series-2" aria-hidden="true"></span>
          Spending
        </li>
      </ul>
      <ll-segmented
        class="w-40"
        label="Show the months as"
        [options]="views"
        [(value)]="view"
        data-testid="chart-view"
      />
    </div>

    <p class="sr-only" data-testid="chart-summary">{{ summary() }}</p>

    @if (view() === 'chart') {
      <!-- The chart is a keyboard-navigable region (arrow keys step through the months and announce the values); the table
           view carries the same numbers for anyone who would rather read them. -->
      <div class="mt-3" data-testid="monthly-chart">
        <apx-chart
          [chart]="options().chart"
          [series]="options().series"
          [colors]="options().colors"
          [plotOptions]="options().plotOptions"
          [stroke]="options().stroke"
          [dataLabels]="options().dataLabels"
          [legend]="options().legend"
          [grid]="options().grid"
          [xaxis]="options().xaxis"
          [yaxis]="options().yaxis"
          [tooltip]="options().tooltip"
          [states]="options().states"
          [fill]="options().fill"
        />
      </div>
    } @else {
      <div class="mt-3 overflow-x-auto" tabindex="0" role="region" aria-label="Months table">
        <table class="w-full text-sm" data-testid="monthly-table">
          <caption class="sr-only">
            Income, spending and what was left, by month, in
            {{
              currency()
            }}
          </caption>
          <thead>
            <tr class="border-b border-outline-variant text-left text-on-surface-variant">
              <th scope="col" class="py-2 pr-3 font-medium">Month</th>
              <th scope="col" class="py-2 pr-3 text-right font-medium">Income</th>
              <th scope="col" class="py-2 pr-3 text-right font-medium">Spending</th>
              <th scope="col" class="py-2 text-right font-medium">Left over</th>
            </tr>
          </thead>
          <tbody>
            @for (flow of months(); track flow.month) {
              <tr class="border-b border-outline-variant/60 last:border-0">
                <th scope="row" class="py-2 pr-3 text-left font-normal">
                  {{ name(flow.month) }}
                </th>
                <td class="py-2 pr-3 text-right">
                  <ll-money [amountMinor]="flow.inMinor" [currency]="currency()" />
                </td>
                <td class="py-2 pr-3 text-right">
                  <ll-money [amountMinor]="flow.outMinor" [currency]="currency()" />
                </td>
                <td class="py-2 text-right">
                  <ll-money
                    [amountMinor]="flow.inMinor - flow.outMinor"
                    [currency]="currency()"
                    [signed]="true"
                  />
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
  host: { class: 'block' },
})
export class MonthlyChart {
  private readonly theme = inject(ThemeService);
  private readonly document = inject(DOCUMENT);

  readonly months = input.required<readonly MonthlyFlow[]>();
  readonly currency = input.required<string>();

  protected readonly views = VIEWS;
  protected readonly view = signal<View>('chart');
  protected readonly name = monthName;
  protected readonly summary = computed(() => describeMonths(this.months(), this.currency()));

  protected readonly options = computed<
    Required<
      Pick<
        ApexOptions,
        | 'chart'
        | 'series'
        | 'colors'
        | 'plotOptions'
        | 'stroke'
        | 'dataLabels'
        | 'legend'
        | 'grid'
        | 'xaxis'
        | 'yaxis'
        | 'tooltip'
        | 'states'
        | 'fill'
      >
    >
  >(() => {
    const scheme = this.theme.scheme();
    const ink = readInk(scheme, this.document);
    const colors = SERIES_COLORS[scheme];
    const currency = this.currency();
    const factor = 10 ** currencyExponent(currency);
    const months = this.months();

    return {
      chart: {
        type: 'bar',
        height: 300,
        background: 'transparent',
        foreColor: ink.ink2,
        fontFamily: 'inherit',
        toolbar: { show: false },
        zoom: { enabled: false },
        parentHeightOffset: 0,
        animations: { enabled: !prefersReducedMotion() },
        // What a screen reader says about the chart, and keyboard access to every column: the same readout the pointer gets.
        accessibility: {
          enabled: true,
          description: this.summary(),
          announcements: { enabled: true },
          keyboard: { enabled: true, navigation: { enabled: true, wrapAround: false } },
        },
      },
      series: [
        { name: 'Income', data: months.map((flow) => flow.inMinor / factor) },
        { name: 'Spending', data: months.map((flow) => flow.outMinor / factor) },
      ],
      colors: [colors.income, colors.spending],
      plotOptions: { bar: { columnWidth: '50%', borderRadius: 4, borderRadiusApplication: 'end' } },
      // The surface-coloured stroke is the 2px gap that separates neighbouring columns; there is no border on a column.
      stroke: { show: true, width: 2, colors: [ink.surface] },
      dataLabels: { enabled: false },
      legend: { show: false },
      fill: { opacity: 1 },
      grid: {
        borderColor: ink.grid,
        strokeDashArray: 0,
        xaxis: { lines: { show: false } },
        yaxis: { lines: { show: true } },
        padding: { left: 8, right: 8 },
      },
      xaxis: {
        categories: monthLabels(months.map((flow) => flow.month)),
        axisBorder: { show: true, color: ink.baseline },
        axisTicks: { show: false },
        labels: { style: { colors: ink.ink2, fontSize: '12px' } },
        tooltip: { enabled: false },
      },
      yaxis: {
        min: 0,
        forceNiceScale: true,
        labels: {
          style: { colors: ink.ink2, fontSize: '12px' },
          formatter: (value: number) => COMPACT.format(value),
        },
      },
      tooltip: {
        shared: true,
        intersect: false,
        theme: scheme,
        y: { formatter: (value: number) => formatMoney(Math.round(value * factor), currency) },
      },
      states: { hover: { filter: { type: 'lighten' } }, active: { filter: { type: 'none' } } },
    };
  });
}
