import { BreakpointObserver } from '@angular/cdk/layout';
import { DOCUMENT } from '@angular/common';
import {
  afterNextRender,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { MatBadge } from '@angular/material/badge';
import { MatIconButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatListItem, MatListItemIcon, MatListItemTitle, MatNavList } from '@angular/material/list';
import { MatSidenav, MatSidenavContainer, MatSidenavContent } from '@angular/material/sidenav';
import { MatTooltip } from '@angular/material/tooltip';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map, skip } from 'rxjs';
import { InspectorPanel } from '../../features/inspector/inspector-panel';
import { StatusChip } from '../../shared/status-chip/status-chip';
import { EventStream } from '../events/events';
import { InspectorStore } from '../inspector/inspector';
import { SessionService } from '../session/session';
import { ThemeService } from '../theme/theme';

interface NavItem {
  path: string;
  label: string;
  icon: string;
}

const DESKTOP_QUERY = '(min-width: 1024px)';

@Component({
  selector: 'll-shell',
  imports: [
    InspectorPanel,
    MatBadge,
    MatIcon,
    MatIconButton,
    MatListItem,
    MatListItemIcon,
    MatListItemTitle,
    MatNavList,
    MatSidenav,
    MatSidenavContainer,
    MatSidenavContent,
    MatTooltip,
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    StatusChip,
  ],
  templateUrl: './shell.html',
})
export class Shell {
  protected readonly session = inject(SessionService);
  protected readonly inspector = inject(InspectorStore);
  protected readonly theme = inject(ThemeService);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly content = viewChild<ElementRef<HTMLElement>>('content');

  protected readonly navItems: readonly NavItem[] = [
    { path: '/dashboard', label: 'Dashboard', icon: 'space_dashboard' },
    { path: '/transactions', label: 'Transactions', icon: 'receipt_long' },
    { path: '/payments', label: 'Payments', icon: 'send' },
    { path: '/connections', label: 'Connections', icon: 'account_balance' },
  ];

  protected readonly desktop = toSignal(
    inject(BreakpointObserver)
      .observe(DESKTOP_QUERY)
      .pipe(map((state) => state.matches)),
    { initialValue: inject(BreakpointObserver).isMatched(DESKTOP_QUERY) },
  );
  protected readonly navOpen = signal(false);

  /** The unseen-calls badge is visible text, so the accessible name has to carry the same number (WCAG 2.5.3). */
  protected readonly inspectorLabel = computed(() => {
    if (this.inspector.open()) return 'Close API Inspector';
    const unseen = this.inspector.unseen();
    return unseen > 0
      ? `Open API Inspector, ${unseen} new ${unseen === 1 ? 'call' : 'calls'}`
      : 'Open API Inspector';
  });

  protected readonly modeLabel = computed(() => {
    const mode = this.session.mode();
    return mode === 'mock' ? 'Mock bank' : mode === 'sandbox' ? 'Sandbox' : 'Live banks';
  });
  protected readonly modeTone = computed(() =>
    this.session.mode() === 'live'
      ? 'error'
      : this.session.mode() === 'sandbox'
        ? 'warning'
        : 'info',
  );
  protected readonly modeHint = computed(() =>
    this.session.mode() === 'mock'
      ? 'Everything here comes from a built-in fake bank. No real money or data is involved.'
      : this.session.mode() === 'sandbox'
        ? 'Connected to a provider’s test environment with fake banks and fake money.'
        : 'Connected to real banks. Only your own accounts are available.',
  );

  constructor() {
    inject(EventStream).connect();
    void this.inspector.load();

    // After a client-side navigation, move focus to the page so keyboard and screen-reader users start at the top.
    inject(Router)
      .events.pipe(
        filter((event) => event instanceof NavigationEnd),
        skip(1),
        takeUntilDestroyed(),
      )
      .subscribe(() => {
        this.navOpen.set(false);
        this.content()?.nativeElement.focus({ preventScroll: true });
      });
  }

  protected toggleInspector(): void {
    if (this.inspector.open()) {
      this.closeInspector();
      return;
    }
    this.inspector.open.set(true);
    this.inspector.markSeen();
    // A complementary panel, not a dialog: move focus in so keyboard and screen-reader users land on it.
    afterNextRender(() => this.document.getElementById('inspector-title')?.focus(), {
      injector: this.injector,
    });
  }

  protected closeInspector(): void {
    if (!this.inspector.open()) return;
    this.inspector.open.set(false);
    this.document.getElementById('inspector-toggle')?.focus();
  }
}
