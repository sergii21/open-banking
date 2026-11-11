import { Service, signal } from '@angular/core';
import type { FopRate } from '@ledger-lens/contracts';

export type ThemeChoice = 'system' | 'light' | 'dark';

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string | null): void => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage can be blocked; the choice then lasts until the page closes.
  }
};

/** Per-browser conveniences: the theme and the blurred amounts. theme-init.js applies them before the first paint. */
@Service()
export class Prefs {
  readonly theme = signal<ThemeChoice>(
    read('ll.theme') === 'light' ? 'light' : read('ll.theme') === 'dark' ? 'dark' : 'system',
  );
  readonly hidden = signal(read('ll.private') === '1');
  /** The single-tax rate the ФОП report works with: 5 percent without VAT, 3 percent with it. */
  readonly fopRate = signal<FopRate>(read('ll.fopRate') === '3' ? 3 : 5);

  /** Declarations the person marked as filed, as "2026-3": a statement cannot show that, so they say it. */
  readonly fopFiled = signal<readonly string[]>(
    (read('ll.fopFiled') ?? '').split(',').filter((key) => /^\d{4}-[1-4]$/.test(key)),
  );

  setFopFiled(key: string, filed: boolean): void {
    const rest = this.fopFiled().filter((k) => k !== key);
    const next = filed ? [...rest, key] : rest;
    this.fopFiled.set(next);
    write('ll.fopFiled', next.length > 0 ? next.join(',') : null);
  }

  setFopRate(rate: FopRate): void {
    this.fopRate.set(rate);
    write('ll.fopRate', rate === 3 ? '3' : null);
  }

  setTheme(choice: ThemeChoice): void {
    this.theme.set(choice);
    write('ll.theme', choice === 'system' ? null : choice);
    const root = document.documentElement;
    if (choice === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', choice);
  }

  setHidden(hidden: boolean): void {
    this.hidden.set(hidden);
    write('ll.private', hidden ? '1' : null);
    document.documentElement.toggleAttribute('data-private', hidden);
  }
}
