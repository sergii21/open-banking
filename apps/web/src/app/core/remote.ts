import { signal } from '@angular/core';
import { ApiError } from './api';

/**
 * One piece of server data. The first load shows a skeleton; every reload after that keeps the old data on screen and swaps
 * the new in when it arrives, so a step finishing in the background never makes a screen flash.
 */
export class Remote<T> {
  readonly data = signal<T | null>(null);
  readonly error = signal<ApiError | null>(null);
  /** No data yet. */
  readonly loading = signal(false);
  /** Data on screen, newer data on the way. */
  readonly refreshing = signal(false);
  private controller: AbortController | null = null;

  constructor(private readonly fetcher: (signal: AbortSignal) => Promise<T>) {}

  async reload(): Promise<void> {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    if (this.data() === null) this.loading.set(true);
    else this.refreshing.set(true);
    try {
      const value = await this.fetcher(controller.signal);
      if (this.controller !== controller) return;
      this.data.set(value);
      this.error.set(null);
    } catch (error) {
      if (this.controller !== controller) return;
      if (error instanceof DOMException && error.name === 'AbortError') return;
      this.error.set(
        error instanceof ApiError ? error : new ApiError(0, 'offline', 'Something went wrong.'),
      );
    } finally {
      if (this.controller === controller) {
        this.loading.set(false);
        this.refreshing.set(false);
      }
    }
  }

  /** Loads once; later calls do nothing while there is data or a load under way. */
  ensure(): void {
    if (this.data() === null && !this.loading()) void this.reload();
  }

  reset(): void {
    this.controller?.abort();
    this.controller = null;
    this.data.set(null);
    this.error.set(null);
    this.loading.set(false);
    this.refreshing.set(false);
  }
}
