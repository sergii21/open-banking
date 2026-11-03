import { Component, inject, signal } from '@angular/core';
import type { InspectorCall } from '@ledger-lens/contracts';
import { Live } from '../../core/live';
import { Ui } from '../../core/ui';
import { Icon } from '../../shared/icon';

/** Proof that the numbers are real: every call the server made to the bank, newest first, redacted. */
@Component({
  selector: 'll-live-api',
  imports: [Icon],
  template: `
    @if (ui.liveApi()) {
      <aside
        class="api-drawer"
        role="complementary"
        aria-labelledby="api-title"
        (keydown.escape)="ui.liveApi.set(false)"
      >
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
          <button type="button" class="icon-btn" aria-label="Close" (click)="ui.liveApi.set(false)">
            <ll-icon name="x" />
          </button>
        </div>
        <p class="hint" style="padding: 0 20px 8px">
          What this app asked monobank, and what it answered. The token is replaced by [redacted],
          and so are card numbers.
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
  protected readonly open = signal<string | null>(null);

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
