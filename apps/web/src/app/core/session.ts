import { computed, inject, Service, signal } from '@angular/core';
import type { ConnectionInfo, ImportResult, SessionInfo } from '@ledger-lens/contracts';
import { Api } from './api';
import { timeZone } from './format';

export type TokenBank = 'monobank' | 'privatbank';

/** Who is looking and what they have connected. Loaded before the first screen, so routing knows where to start. */
@Service()
export class Session {
  private readonly api = inject(Api);

  readonly info = signal<SessionInfo | null>(null);
  readonly connections = computed(() => this.info()?.connections ?? []);
  readonly connected = computed(() => this.connections().length > 0);
  readonly demo = computed(() => this.connections().some((c) => c.demo));
  readonly live = computed(() => this.info()?.live ?? false);
  /** More than one bank is connected: accounts then say which bank they are at. */
  readonly manyBanks = computed(() => new Set(this.connections().map((c) => c.bank)).size > 1);

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

  setConnections(connections: ConnectionInfo[]): void {
    this.info.update((info) => (info ? { ...info, connections } : info));
  }

  private upsert(connection: ConnectionInfo): void {
    const rest = this.connections().filter((c) => c.id !== connection.id && !c.demo);
    this.setConnections(
      [...rest, connection].sort((a, b) => a.connectedAt.localeCompare(b.connectedAt)),
    );
  }

  async connectDemo(): Promise<void> {
    this.setConnections([await this.api.post<ConnectionInfo>('/api/connection', { mode: 'demo' })]);
  }

  async connectToken(provider: TokenBank, token: string): Promise<void> {
    this.upsert(
      await this.api.post<ConnectionInfo>('/api/connection', { mode: 'token', provider, token }),
    );
  }

  async replaceToken(id: string, token: string): Promise<void> {
    this.upsert(await this.api.put<ConnectionInfo>(`/api/connection/${id}/token`, { token }));
  }

  /** Reads a Privat24 statement file on the server; the connection list then includes the file. */
  async importPrivat24(bytes: ArrayBuffer): Promise<ImportResult> {
    const result = await this.api.upload<ImportResult>('/api/imports/privat24', bytes);
    this.setConnections(result.connections);
    return result;
  }

  async disconnect(id: string): Promise<void> {
    await this.api.delete(`/api/connection/${id}`);
    this.setConnections(this.connections().filter((c) => c.id !== id));
  }

  /** Forget every bank and end the session; the next page load starts a fresh one. */
  async deleteEverything(): Promise<void> {
    await this.api.delete('/api/session');
    this.info.set(null);
    await this.load();
  }
}
