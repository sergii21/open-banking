import {
  ApplicationRef,
  computed,
  effect,
  inject,
  Service,
  signal,
  untracked,
  type Type,
} from '@angular/core';
import { Session } from './session';

export type Page = 'welcome' | 'connect' | 'home' | 'activity' | 'insights';

/** Each screen is its own small chunk, fetched while the browser is idle so a tab switch never waits on the network. */
const LOADERS: Record<Page, () => Promise<Type<unknown>>> = {
  welcome: () => import('../features/welcome/welcome').then((m) => m.Welcome),
  connect: () => import('../features/welcome/welcome').then((m) => m.Welcome),
  home: () => import('../features/home/home').then((m) => m.Home),
  activity: () => import('../features/activity/activity').then((m) => m.Activity),
  insights: () => import('../features/insights/insights').then((m) => m.Insights),
};

const TITLES: Record<Page, string> = {
  welcome: 'Connect · Ledger Lens',
  connect: 'Add a bank · Ledger Lens',
  home: 'Home · Ledger Lens',
  activity: 'Activity · Ledger Lens',
  insights: 'Insights · Ledger Lens',
};

const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Which connected screen a path is; anything unknown is Home. */
function pageOf(pathname: string): Page {
  const path = pathname.replace(/\/+$/, '');
  return path === '/activity'
    ? 'activity'
    : path === '/insights'
      ? 'insights'
      : path === '/connect'
        ? 'connect'
        : 'home';
}

/**
 * Five screens and the browser's own history: that is all the routing this app needs, and not shipping a general router
 * keeps about 100 kB out of the first load. Links are real `<a href>`; a click is handled here unless the person asked for a
 * new tab. Switching tabs cross-fades with the View Transitions API where the browser has it.
 */
@Service()
export class Nav {
  private readonly session = inject(Session);
  private readonly app = inject(ApplicationRef);

  readonly path = signal(location.pathname);
  readonly query = signal(new URLSearchParams(location.search));
  readonly component = signal<Type<unknown> | null>(null);
  private readonly loaded = new Map<Page, Type<unknown>>();

  readonly page = computed<Page>(() => {
    if (!this.session.connected()) return 'welcome';
    return pageOf(this.path());
  });

  constructor() {
    window.addEventListener('popstate', () => {
      this.path.set(location.pathname);
      this.query.set(new URLSearchParams(location.search));
      window.scrollTo(0, 0);
    });
    // A connection appearing or going away (connect, disconnect) switches between the first-run screen and the tabs.
    effect(() => {
      const page = this.page();
      untracked(() => void this.show(page));
    });
    const idle = (window as { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
    (idle ?? ((cb: () => void) => setTimeout(cb, 400)))(() => {
      for (const load of Object.values(LOADERS)) void load();
    });
  }

  private async show(page: Page): Promise<void> {
    let component = this.loaded.get(page);
    if (!component) {
      component = await LOADERS[page]();
      this.loaded.set(page, component);
    }
    if (this.page() !== page) return;
    const canonical = `/${page}`;
    if (location.pathname !== canonical && !(page === 'home' && location.pathname === '/')) {
      history.replaceState(
        null,
        '',
        canonical + (page === 'activity' || page === 'connect' ? location.search : ''),
      );
    } else if (location.pathname === '/') {
      history.replaceState(null, '', canonical);
    }
    this.path.set(location.pathname);
    this.component.set(component);
    document.title = TITLES[page];
  }

  /** Go to a path inside the app. */
  async go(url: string, replace = false): Promise<void> {
    const target = new URL(url, location.href);
    const page: Page = !this.session.connected() ? 'welcome' : pageOf(target.pathname);
    let component = this.loaded.get(page);
    if (!component) {
      component = await LOADERS[page]();
      this.loaded.set(page, component);
    }
    const apply = (): void => {
      history[replace ? 'replaceState' : 'pushState'](null, '', target.pathname + target.search);
      this.path.set(target.pathname);
      this.query.set(new URLSearchParams(target.search));
      this.component.set(component);
      document.title = TITLES[page];
      this.app.tick();
      window.scrollTo(0, 0);
    };
    const start = (document as { startViewTransition?: (cb: () => void) => unknown })
      .startViewTransition;
    if (start && !reducedMotion()) start.call(document, apply);
    else apply();
  }

  /** `(click)` handler for `<a href>` links: stay in the app unless the person wants a new tab. */
  link(event: MouseEvent): void {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const anchor = (event.currentTarget as HTMLAnchorElement | null) ?? null;
    const href = anchor?.getAttribute('href');
    if (!href || anchor?.target === '_blank') return;
    event.preventDefault();
    void this.go(href);
  }
}
