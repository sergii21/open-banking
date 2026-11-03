import { Service, signal } from '@angular/core';

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
