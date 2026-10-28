import { TestBed } from '@angular/core/testing';
import { ThemeService } from './theme';

describe('ThemeService', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('cycles system -> light -> dark, pinning the scheme on <html> and remembering it', () => {
    const theme = TestBed.inject(ThemeService);
    theme.preference.set('system');
    TestBed.tick();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);

    theme.cycle();
    TestBed.tick();
    expect(theme.preference()).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(localStorage.getItem('ll-theme')).toBe('light');

    theme.cycle();
    TestBed.tick();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    theme.cycle();
    TestBed.tick();
    expect(theme.preference()).toBe('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });

  it('describes the current choice for assistive technology', () => {
    const theme = TestBed.inject(ThemeService);
    expect(theme.label()).toBe('Theme: match system');
    theme.cycle();
    expect(theme.label()).toBe('Theme: light');
  });
});
