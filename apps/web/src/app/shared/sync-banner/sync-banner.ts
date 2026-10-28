import { Component, computed, input } from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import type { Connection } from '@ledger-lens/contracts';

/**
 * Banks that cap how often data may be read (monobank: one statement a minute) load their history in the background. This
 * says so, with real progress, instead of leaving the person wondering why older transactions are missing.
 */
@Component({
  selector: 'll-sync-banner',
  imports: [MatIcon],
  template: `
    @for (item of syncing(); track item.id) {
      <div
        class="mb-4 flex items-start gap-3 rounded-2xl bg-secondary-container p-4 text-on-secondary-container"
        role="status"
        data-testid="sync-banner"
      >
        <mat-icon aria-hidden="true">hourglass_top</mat-icon>
        <div class="min-w-0 flex-1">
          <p class="font-semibold">Loading history from {{ item.name }}</p>
          <p class="text-sm">
            {{ item.done }} of {{ item.total }} steps done. {{ item.name }} allows one statement
            request per minute, so older transactions arrive gradually. You can keep using the app;
            this updates by itself.
          </p>
          <div
            class="mt-2 h-2 overflow-hidden rounded-full bg-on-secondary-container/20"
            role="progressbar"
            [attr.aria-label]="'History loaded from ' + item.name"
            aria-valuemin="0"
            [attr.aria-valuemax]="item.total"
            [attr.aria-valuenow]="item.done"
          >
            <div
              class="h-full rounded-full bg-on-secondary-container"
              [style.width.%]="(item.done / item.total) * 100"
            ></div>
          </div>
        </div>
      </div>
    }
  `,
  host: { class: 'block' },
})
export class SyncBanner {
  readonly connections = input.required<readonly Connection[]>();

  protected readonly syncing = computed(() =>
    this.connections().flatMap((c) =>
      c.sync ? [{ id: c.id, name: c.institutionName, done: c.sync.done, total: c.sync.total }] : [],
    ),
  );
}
