import { Component, effect, ElementRef, inject, signal, viewChild } from '@angular/core';
import type { InspectorCall } from '@ledger-lens/contracts';
import { Live } from '../../core/live';
import { Session } from '../../core/session';
import { Ui } from '../../core/ui';
import { Icon } from '../../shared/icon';

/** Proof that the numbers are real: every call the server made to the bank, newest first, redacted. */
@Component({
  selector: 'll-live-api',
  imports: [Icon],
  host: { '(window:keydown.escape)': 'onEscape($event)' },
  template: `
    @if (ui.liveApi()) {
      <aside class="api-drawer" role="complementary" aria-labelledby="api-title">
        <div class="sheet-head">
          <h2 id="api-title">Live API</h2>
          <button
            type="button"
            class="btn btn-sm btn-quiet"
            (click)="live.clearCalls()"
            [disabled]="live.calls().length === 0"
          >
            Clear
          </button>
          <button #close type="button" class="icon-btn" aria-label="Close" (click)="closeDrawer()">
            <ll-icon name="x" />
          </button>
        </div>
        <p class="hint" style="padding: 0 20px 8px">
          @if (session.demo()) {
            You are on demo data: these are the calls this app makes to the built-in demo bank,
            through the same code that talks to monobank. Connect your own token and the real ones
            appear here.
          } @else {
            What this app asked monobank, and what it answered. The token is replaced by [redacted],
            and so are card numbers.
          }
        </p>
        <div class="call-list">
          @for (call of live.calls(); track call.id) {
            <div class="call">
              <button
                type="button"
                [attr.aria-expanded]="open() === call.id"
                (click)="open.set(open() === call.id ? null : call.id)"
              >
                <span class="method">{{ call.method }}</span>
                <span style="min-width: 0">
                  <span class="row-title" style="display: block">{{ call.label }}</span>
                  <code class="row-sub" style="display: block">{{ path(call) }}</code>
                </span>
                <span class="row-end" style="font-weight: 600">
                  <span
                    [class]="call.status !== null && call.status < 400 ? 'status-ok' : 'status-bad'"
                    >{{ call.status ?? 'failed' }}</span
                  >
                  <span class="amt-sub">{{ call.durationMs }} ms</span>
                </span>
              </button>
              @if (open() === call.id) {
                <pre>{{ detail(call) }}</pre>
              }
            </div>
          } @empty {
            <div class="empty"><p>Nothing yet. Calls appear here as they happen.</p></div>
          }
        </div>
      </aside>
    }
  `,
})
export class LiveApi {
  protected readonly ui = inject(Ui);
  protected readonly live = inject(Live);
  protected readonly session = inject(Session);
  protected readonly open = signal<string | null>(null);
  private readonly closeButton = viewChild<ElementRef<HTMLButtonElement>>('close');
  private opener: HTMLElement | null = null;

  constructor() {
    // The drawer takes focus when it opens (its Close button) and remembers where focus was, so closing can give it back.
    effect(() => {
      const button = this.closeButton()?.nativeElement;
      if (!button) return;
      const active = document.activeElement;
      this.opener = active instanceof HTMLElement && active !== document.body ? active : null;
      // After the frame: the Settings sheet that opened the drawer is closing in the same breath and hands focus back first.
      requestAnimationFrame(() => {
        if (button.isConnected) button.focus();
      });
    });
  }

  protected closeDrawer(): void {
    this.ui.liveApi.set(false);
    // Back to where the person came from. The "Live API" button lived in the Settings sheet, which is gone by now, so the
    // control that opened Settings gets the focus.
    const usable = this.opener?.isConnected === true && this.opener.offsetParent !== null;
    (usable ? this.opener : document.getElementById('settings-btn'))?.focus();
    this.opener = null;
  }

  /** The drawer is non-modal, so Escape works from anywhere, unless a modal sheet is on top: that one closes first. */
  protected onEscape(event: Event): void {
    if (!this.ui.liveApi() || document.querySelector('dialog[open]')) return;
    event.preventDefault();
    this.closeDrawer();
  }

  protected path(call: InspectorCall): string {
    try {
      const url = new URL(call.url);
      return `${url.host}${url.pathname}`;
    } catch {
      return call.url;
    }
  }

  protected detail(call: InspectorCall): string {
    return JSON.stringify(
      {
        at: call.at,
        request: call.request,
        response: call.response ? { status: call.status, ...call.response } : { error: call.error },
        truncated: call.truncated || undefined,
      },
      null,
      2,
    );
  }
}
