import { DOCUMENT } from '@angular/common';
import { computed, effect, inject, Service, signal } from '@angular/core';

export type ThemePreference = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'll-theme';
const ORDER: readonly ThemePreference[] = ['system', 'light', 'dark'];

function readStored(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system'; // storage can be blocked (private windows, embedded previews)
  }
}

/** Light/dark/system. `system` follows the OS through `color-scheme`; the other two pin it on <html>. */
@Service()
export class ThemeService {
  private readonly document = inject(DOCUMENT);

  readonly preference = signal<ThemePreference>(readStored());
  readonly icon = computed(
    () =>
      ({ system: 'brightness_auto', light: 'light_mode', dark: 'dark_mode' })[this.preference()],
  );
  readonly label = computed(
    () =>
      ({ system: 'Theme: match system', light: 'Theme: light', dark: 'Theme: dark' })[
        this.preference()
      ],
  );

  constructor() {
    effect(() => {
      const preference = this.preference();
      const root = this.document.documentElement;
      if (preference === 'system') root.removeAttribute('data-theme');
      else root.setAttribute('data-theme', preference);
      try {
        localStorage.setItem(STORAGE_KEY, preference);
      } catch {
        // Not persisted; the choice still applies for this visit.
      }
    });
  }

  cycle(): void {
    this.preference.update(
      (current) => ORDER[(ORDER.indexOf(current) + 1) % ORDER.length] ?? 'system',
    );
  }
}
