import { computed, inject, Service, signal } from '@angular/core';
import type { ConnectionInfo, SessionInfo } from '@ledger-lens/contracts';
import { Api } from './api';
import { timeZone } from './format';

/** Who is looking and what they have connected. Loaded before the first screen, so routing knows where to start. */
@Service()
export class Session {
  private readonly api = inject(Api);

  readonly info = signal<SessionInfo | null>(null);
  readonly connection = computed(() => this.info()?.connection ?? null);
  readonly connected = computed(() => this.connection() !== null);
  readonly demo = computed(() => this.connection()?.demo ?? false);
  readonly live = computed(() => this.info()?.live ?? false);

  async load(): Promise<void> {
    try {
      const info = await this.api.get<SessionInfo>('/api/session');
      timeZone.set(info.timeZone);
      this.info.set(info);
    } catch {
      // The screens show their own "cannot reach Ledger Lens" state; routing falls back to the first-run screen.
      this.info.set(null);
    }
  }

  setConnection(connection: ConnectionInfo | null): void {
    this.info.update((info) => (info ? { ...info, connection } : info));
  }

  async connectDemo(): Promise<void> {
    this.setConnection(await this.api.post<ConnectionInfo>('/api/connection', { mode: 'demo' }));
  }

  async connectToken(token: string): Promise<void> {
    this.setConnection(
      await this.api.post<ConnectionInfo>('/api/connection', { mode: 'token', token }),
    );
  }

  async replaceToken(token: string): Promise<void> {
    this.setConnection(await this.api.put<ConnectionInfo>('/api/connection/token', { token }));
  }

  async disconnect(): Promise<void> {
    await this.api.delete('/api/connection');
    this.setConnection(null);
  }

  /** Forget the bank and end the session; the next page load starts a fresh one. */
  async deleteEverything(): Promise<void> {
    await this.api.delete('/api/session');
    this.info.set(null);
    await this.load();
  }
}
