import { fromBase64, type FamilyKeys } from './crypto';

/** As much of `fetch` as the relay needs, so the tests can put a real relay behind it without a network. */
export type RelayWire = (
  url: string,
  init: {
    method: 'GET' | 'PUT' | 'DELETE';
    headers: Record<string, string>;
    body?: Uint8Array;
    signal: AbortSignal;
  },
) => Promise<{ status: number; text(): Promise<string> }>;

export const fetchRelayWire: RelayWire = (url, init) =>
  fetch(url, { ...init, body: init.body ? Uint8Array.from(init.body) : undefined });

export type RelayProblem =
  | 'offline' // no answer
  | 'slow-down'
  | 'wrong-key' // the relay has this family under another key
  | 'family-full'
  | 'relay-full'
  | 'failed';

export class RelayError extends Error {
  constructor(readonly problem: RelayProblem) {
    super(problem);
  }
}

export interface SealedMember {
  id: string;
  updatedAt: number;
  blob: Uint8Array;
}

const TIMEOUT_MS = 15_000;

/**
 * The phone's second and last way to the network, beside the bank's (`bank/http.ts`), and the only one that writes.
 * What it writes is a summary already sealed on this phone (`crypto.ts`), to the one relay address the family uses,
 * over HTTPS. The bank token never comes near this file.
 */
export class RelayClient {
  private readonly base: string;

  constructor(
    private readonly wire: RelayWire,
    /** `https://…` with no trailing slash: checked by `cleanRelayUrl` before it gets here. */
    relayUrl: string,
    private readonly keys: FamilyKeys,
  ) {
    if (!relayUrl.startsWith('https://')) throw new RelayError('failed');
    this.base = `${relayUrl}/v1/families/${keys.familyId}`;
  }

  private async call(
    method: 'GET' | 'PUT' | 'DELETE',
    path: string,
    body?: Uint8Array,
  ): Promise<{ status: number; text: string }> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
    try {
      const response = await this.wire(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.keys.accessKey}`,
          ...(body ? { 'content-type': 'application/octet-stream' } : {}),
        },
        ...(body ? { body } : {}),
        signal: abort.signal,
      });
      const text = await response.text();
      if (response.status === 429) throw new RelayError('slow-down');
      if (response.status === 403) throw new RelayError('wrong-key');
      if (response.status === 409) throw new RelayError('family-full');
      if (response.status === 507) throw new RelayError('relay-full');
      return { status: response.status, text };
    } catch (error) {
      if (error instanceof RelayError) throw error;
      throw new RelayError('offline');
    } finally {
      clearTimeout(timer);
    }
  }

  /** Everyone's sealed summaries. An empty list when the relay has no such family (yet, or any more). */
  async list(): Promise<SealedMember[]> {
    const { status, text } = await this.call('GET', '');
    if (status === 404) return [];
    if (status !== 200) throw new RelayError('failed');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new RelayError('failed');
    }
    const members = (parsed as { members?: unknown }).members;
    if (!Array.isArray(members)) throw new RelayError('failed');
    const out: SealedMember[] = [];
    for (const entry of members as { id?: unknown; updatedAt?: unknown; blob?: unknown }[]) {
      const blob = typeof entry.blob === 'string' ? fromBase64(entry.blob) : null;
      if (typeof entry.id !== 'string' || typeof entry.updatedAt !== 'number' || !blob) continue;
      out.push({ id: entry.id, updatedAt: entry.updatedAt, blob });
    }
    return out;
  }

  async put(memberId: string, blob: Uint8Array): Promise<void> {
    const { status } = await this.call('PUT', `/members/${memberId}`, blob);
    if (status !== 204) throw new RelayError('failed');
  }

  async remove(memberId: string): Promise<void> {
    const { status } = await this.call('DELETE', `/members/${memberId}`);
    if (status !== 204 && status !== 404) throw new RelayError('failed');
  }
}
