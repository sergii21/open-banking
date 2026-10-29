import { Component, computed, inject, output, signal } from '@angular/core';
import { MatIconButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';
import { MatTooltip } from '@angular/material/tooltip';
import { InspectorStore } from '../../core/inspector/inspector';
import { SessionService } from '../../core/session/session';
import { Segmented, type SegmentOption } from '../../shared/segmented/segmented';
import { CallItem } from './call-item';
import { DemoControls } from './demo-controls';

@Component({
  selector: 'll-inspector-panel',
  imports: [CallItem, DemoControls, MatIcon, MatIconButton, MatTooltip, Segmented],
  template: `
    <section class="flex h-full flex-col" aria-labelledby="inspector-title">
      <header
        class="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-outline-variant py-2 pr-2 pl-4"
      >
        <mat-icon aria-hidden="true" class="text-primary">troubleshoot</mat-icon>
        <h2
          id="inspector-title"
          tabindex="-1"
          class="mr-auto text-lg font-semibold tracking-tight outline-none"
        >
          API Inspector
        </h2>
        <ll-segmented
          label="Which calls to show"
          [options]="scopes()"
          [value]="store.scope()"
          (valueChange)="store.scope.set($event)"
          class="max-[639px]:order-last max-[639px]:w-full min-[1440px]:order-last min-[1440px]:w-full"
        />
        <button
          mat-icon-button
          type="button"
          aria-label="Clear recorded calls"
          matTooltip="Clear"
          (click)="clear()"
        >
          <mat-icon>delete_sweep</mat-icon>
        </button>
        <button
          mat-icon-button
          type="button"
          aria-label="Close API Inspector"
          matTooltip="Close"
          (click)="closed.emit()"
        >
          <mat-icon>close</mat-icon>
        </button>
      </header>

      <p class="hidden px-4 pt-3 text-sm text-on-surface-variant min-[1440px]:block">
        The real calls the server made to the bank behind this screen. Reading a screen uses cached
        data; calls happen when you connect, refresh or pay.
      </p>

      <div
        class="min-h-0 flex-1 overflow-y-auto px-1 py-2"
        aria-live="polite"
        aria-relevant="additions"
      >
        @if (calls().length === 0) {
          <div
            class="px-4 py-4 text-center text-on-surface-variant min-[1440px]:py-8"
            data-testid="inspector-empty"
          >
            <mat-icon class="!size-8 !text-[32px]">hourglass_empty</mat-icon>
            @if (store.scope() === 'screen') {
              <p class="mt-2 font-medium text-on-surface">No provider calls on this screen</p>
              <p class="mt-1 text-sm">
                This screen showed data the server already had. Press Refresh on an account, or
                connect a bank, and the real calls appear here.
              </p>
              @if (store.all().length > 0) {
                <button type="button" class="mt-3 underline" (click)="store.scope.set('all')">
                  Show all {{ store.all().length }} calls
                </button>
              }
            } @else {
              <p class="mt-2 font-medium text-on-surface">Nothing recorded yet</p>
              <p class="mt-1 text-sm">Connect a bank to see the calls.</p>
            }
          </div>
        } @else {
          <ul role="list" class="divide-y divide-outline-variant/60" data-testid="inspector-calls">
            @for (call of calls(); track call.id) {
              <li>
                <ll-call-item
                  [call]="call"
                  [expanded]="expandedId() === call.id"
                  (selectCall)="toggle(call.id)"
                />
              </li>
            }
          </ul>
        }
      </div>

      @if (session.demoControls()) {
        <ll-demo-controls class="border-t border-outline-variant" />
      }
    </section>
  `,
  host: { class: 'block h-full' },
})
export class InspectorPanel {
  /** The shell owns focus restoration, so closing goes through it. */
  readonly closed = output();

  protected readonly store = inject(InspectorStore);
  protected readonly session = inject(SessionService);

  protected readonly expandedId = signal<string | null>(null);
  protected readonly calls = computed(() => this.store.visible());
  protected readonly scopes = computed<SegmentOption<'screen' | 'all'>[]>(() => [
    { value: 'screen', label: 'This screen' },
    { value: 'all', label: `All calls (${this.store.all().length})` },
  ]);

  protected toggle(id: string): void {
    this.expandedId.update((current) => (current === id ? null : id));
  }

  protected async clear(): Promise<void> {
    await this.store.clear();
    this.expandedId.set(null);
  }
}
