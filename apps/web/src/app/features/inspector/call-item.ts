import { Component, computed, inject, input, output } from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import type { InspectorCall } from '@ledger-lens/contracts';
import { Ticker } from '../../core/clock/ticker';
import { formatRelative } from '../../shared/format';
import { StatusChip, type Tone } from '../../shared/status-chip/status-chip';

const pretty = (value: unknown): string => JSON.stringify(value, null, 2);

const headerLines = (headers: Record<string, string>): string =>
  Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');

/** Renders one half of an exchange like a wire trace: start line, headers, blank line, body. */
const trace = (startLine: string, headers: Record<string, string>, body: unknown): string =>
  [
    startLine,
    headerLines(headers),
    body === null || body === undefined
      ? ''
      : `\n${typeof body === 'string' ? body : pretty(body)}`,
  ]
    .filter((part) => part !== '')
    .join('\n');

/** One provider call in the Inspector: a summary row that expands into the redacted request and response. */
@Component({
  selector: 'll-call-item',
  imports: [MatIcon, StatusChip],
  template: `
    <button
      type="button"
      class="flex w-full flex-col gap-1 rounded-xl px-3 py-2 text-left hover:bg-surface-container focus-visible:bg-surface-container"
      [attr.aria-expanded]="expanded()"
      [attr.aria-controls]="detailId()"
      (click)="selectCall.emit()"
    >
      <span class="flex items-center gap-2">
        <span
          class="rounded-md bg-surface-container-high px-1.5 py-0.5 font-mono text-xs font-semibold"
          data-testid="call-method"
          >{{ call().method }}</span
        >
        <span class="min-w-0 flex-1 truncate font-medium" data-testid="call-label">{{
          call().label
        }}</span>
        <ll-status-chip [tone]="tone()" [icon]="icon()" data-testid="call-status">{{
          statusText()
        }}</ll-status-chip>
        <mat-icon class="text-on-surface-variant">{{
          expanded() ? 'expand_less' : 'expand_more'
        }}</mat-icon>
      </span>
      <span
        class="truncate font-mono text-xs text-on-surface-variant"
        [title]="call().url"
        data-testid="call-url"
        >{{ shortUrl() }}</span
      >
      <span class="text-xs text-on-surface-variant"
        >{{ call().durationMs }} ms · {{ ago()
        }}{{ call().provider === 'mock' ? ' · mock bank' : '' }}</span
      >
    </button>
    @if (expanded()) {
      <div [id]="detailId()" class="space-y-3 px-3 pt-1 pb-3" data-testid="call-detail">
        <section>
          <h3 class="mb-1 text-xs font-semibold tracking-wide text-on-surface-variant uppercase">
            Request
          </h3>
          <pre
            class="max-h-56 overflow-auto rounded-lg bg-surface-container-high p-3 font-mono text-xs leading-relaxed"
            tabindex="0"
            >{{ request() }}</pre>
        </section>
        <section>
          <h3 class="mb-1 text-xs font-semibold tracking-wide text-on-surface-variant uppercase">
            Response
          </h3>
          <pre
            class="max-h-72 overflow-auto rounded-lg bg-surface-container-high p-3 font-mono text-xs leading-relaxed"
            tabindex="0"
            >{{ response() }}</pre>
          @if (call().truncated) {
            <p class="mt-1 text-xs text-on-surface-variant">
              Long arrays and strings are shortened here to keep the buffer small.
            </p>
          }
        </section>
        <p class="text-xs text-on-surface-variant">
          Tokens, secrets and signatures are redacted before anything is stored.
        </p>
      </div>
    }
  `,
  host: { class: 'block' },
})
export class CallItem {
  private readonly ticker = inject(Ticker);

  readonly call = input.required<InspectorCall>();
  readonly expanded = input(false);
  readonly selectCall = output();

  protected readonly detailId = computed(() => `call-detail-${this.call().id}`);
  protected readonly ago = computed(() =>
    formatRelative(Date.parse(this.call().at), this.ticker.now()),
  );
  protected readonly shortUrl = computed(() => this.call().url.replace(/^https?:\/\//, ''));
  protected readonly statusText = computed(() => {
    const call = this.call();
    return call.status === null ? (call.error ?? 'No response') : String(call.status);
  });
  protected readonly tone = computed<Tone>(() => {
    const status = this.call().status;
    if (status === null || status >= 500) return 'error';
    if (status >= 400) return 'warning';
    return 'success';
  });
  protected readonly icon = computed(() => {
    const status = this.call().status;
    return status === null || status >= 500 ? 'error' : status >= 400 ? 'warning' : 'check_circle';
  });
  protected readonly request = computed(() => {
    const { method, url, request } = this.call();
    return trace(`${method} ${url}`, request.headers, request.body);
  });
  protected readonly response = computed(() => {
    const call = this.call();
    if (!call.response) return call.error ?? 'No response';
    return trace(
      `HTTP ${call.status ?? ''} · ${call.durationMs} ms`,
      call.response.headers,
      call.response.body,
    );
  });
}
