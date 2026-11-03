import { Component, computed, input } from '@angular/core';
import type { Category } from '@ledger-lens/contracts';

/** Hand-drawn 24px line icons (stroke, round caps). Each entry is a list of path data. */
const ICONS = {
  home: ['M3 10.8 12 3.5l9 7.3', 'M5 9.5V20h5v-5.5h4V20h5V9.5'],
  list: ['M8 6.5h12', 'M8 12h12', 'M8 17.5h12', 'M4 6.5h.01', 'M4 12h.01', 'M4 17.5h.01'],
  chart: ['M4 20h16', 'M7 20v-7', 'M12 20V6', 'M17 20v-10'],
  sliders: ['M4 7h9', 'M17 7h3', 'M4 17h3', 'M11 17h9', 'M15 4.5v5', 'M9 14.5v5'],
  eye: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z', 'M12 9.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6Z'],
  'eye-off': ['M3.5 3.5l17 17', 'M9.9 5.8A9 9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-3.2 3.9', 'M6.2 7.6C3.9 9.3 2.5 12 2.5 12S6 18.5 12 18.5c1.3 0 2.5-.3 3.6-.8', 'M9.9 10a2.8 2.8 0 0 0 4 4'],
  search: ['M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13Z', 'm20 20-4.7-4.7'],
  x: ['M6 6l12 12', 'M18 6 6 18'],
  'chevron-right': ['m9 5 7 7-7 7'],
  'chevron-left': ['m15 5-7 7 7 7'],
  refresh: ['M20 12a8 8 0 1 1-2.6-5.9', 'M20 4v5h-5'],
  copy: ['M9 9h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z', 'M5 15V6a1 1 0 0 1 1-1h9'],
  download: ['M12 4v11', 'm7.5 11 4.5 4.5 4.5-4.5', 'M5 20h14'],
  check: ['m5 12.5 4.5 4.5L19 7.5'],
  alert: ['M12 4 2.8 19.5h18.4Z', 'M12 10v4.5', 'M12 17.2h.01'],
  info: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z', 'M12 11v5', 'M12 8h.01'],
  card: ['M5 5.5h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z', 'M3 10h18', 'M7 15h3'],
  jar: ['M8.5 3.5h7', 'M7.5 6.5h9', 'M7 6.5c-1 1-1.5 2-1.5 3.5v8a2.5 2.5 0 0 0 2.5 2.5h8a2.5 2.5 0 0 0 2.5-2.5v-8c0-1.5-.5-2.5-1.5-3.5', 'M9.5 13.5h5'],
  sun: ['M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z', 'M12 2.5v2', 'M12 19.5v2', 'M2.5 12h2', 'M19.5 12h2', 'm5.3 5.3 1.4 1.4', 'm17.3 17.3 1.4 1.4', 'm5.3 18.7 1.4-1.4', 'm17.3 6.7 1.4-1.4'],
  moon: ['M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z'],
  monitor: ['M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z', 'M8 20h8', 'M12 17v3'],
  plug: ['M9 3v4', 'M15 3v4', 'M6.5 7h11v3.5a5.5 5.5 0 0 1-11 0Z', 'M12 16v5'],
  trash: ['M4 7h16', 'M9 7V4.5h6V7', 'M6.5 7 7.5 20h9l1-13', 'M10 11v5.5', 'M14 11v5.5'],
  shield: ['M12 3 4.5 6v5.5c0 4.5 3.2 8.2 7.5 9.5 4.3-1.3 7.5-5 7.5-9.5V6Z', 'm9 12 2.2 2.2L15.5 10'],
  lock: ['M6 11h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z', 'M8.5 11V8a3.5 3.5 0 0 1 7 0v3'],
  clock: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17Z', 'M12 7.5V12l3 2'],
  tag: ['M3.5 12.5V5a1.5 1.5 0 0 1 1.5-1.5h7.5l8 8-9 9Z', 'M8 8h.01'],
  external: ['M14 4h6v6', 'M20 4 10.5 13.5', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  filter: ['M4 6.5h16', 'M7 12h10', 'M10 17.5h4'],
  lens: ['M10.8 5a5.8 5.8 0 1 0 0 11.6 5.8 5.8 0 0 0 0-11.6Z', 'm19 19-4.1-4.1'],
  cart: ['M3 4h2.2l2 11h10.3l2-8H6.3', 'M9.2 19.5h.01', 'M16.8 19.5h.01'],
  utensils: ['M7 3v7a2 2 0 0 0 2 2', 'M11 3v7a2 2 0 0 1-2 2', 'M9 12v9', 'M17 21V3c-2.2 1.2-3.5 3.8-3.5 7v3H17'],
  car: ['M5 16.5V12l1.8-4.8A1.5 1.5 0 0 1 8.2 6h7.6a1.5 1.5 0 0 1 1.4 1.2L19 12v4.5', 'M3.5 12h17', 'M5 16.5h14', 'M7 19v-2.5', 'M17 19v-2.5', 'M7.5 14.2h.01', 'M16.5 14.2h.01'],
  bag: ['M6 8h12l1 12.5H5Z', 'M9 8V6.5a3 3 0 0 1 6 0V8'],
  bolt: ['M13 2.5 5 13.5h6l-1 8 8-11h-6Z'],
  repeat: ['M17 3.5 20.5 7 17 10.5', 'M3.5 11V10a3 3 0 0 1 3-3h14', 'M7 20.5 3.5 17 7 13.5', 'M20.5 13v1a3 3 0 0 1-3 3h-14'],
  heart: ['M12 20.5S3.5 15.5 3.5 9.2A4.7 4.7 0 0 1 12 6.6a4.7 4.7 0 0 1 8.5 2.6c0 6.3-8.5 11.3-8.5 11.3Z'],
  film: ['M5 4.5h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1Z', 'm10.5 9 4 3-4 3Z'],
  plane: ['M10.5 13.5 3.5 10l1-1.8 7.2 1.3 4.6-4.6a1.8 1.8 0 0 1 2.6 2.6l-4.6 4.6 1.3 7.2-1.8 1-3.5-7Z'],
  swap: ['M4 8.5h14.5', 'm15 5 3.5 3.5L15 12', 'M20 15.5H5.5', 'm9 12-3.5 3.5L9 19'],
  inbox: ['M12 3.5v11', 'm7.5 10.5 4.5 4.5 4.5-4.5', 'M4.5 15v3.5a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1V15'],
  dots: ['M5.5 12h1', 'M11.5 12h1', 'M17.5 12h1'],
} as const;

export type IconName = keyof typeof ICONS;

const CATEGORY_ICONS: Record<Category, IconName> = {
  groceries: 'cart',
  dining: 'utensils',
  transport: 'car',
  shopping: 'bag',
  bills: 'bolt',
  subscriptions: 'repeat',
  health: 'heart',
  entertainment: 'film',
  travel: 'plane',
  transfers: 'swap',
  income: 'inbox',
  other: 'dots',
};
export const categoryIcon = (category: Category): IconName => CATEGORY_ICONS[category];

@Component({
  selector: 'll-icon',
  template: `<svg
    [attr.width]="size()"
    [attr.height]="size()"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    @for (d of paths(); track $index) {
      <path [attr.d]="d" />
    }
  </svg>`,
  host: { style: 'display:inline-flex;line-height:0' },
})
export class Icon {
  readonly name = input.required<IconName>();
  readonly size = input(22);
  protected readonly paths = computed(() => ICONS[this.name()]);
}
