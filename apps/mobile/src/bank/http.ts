import { AppError } from '@api/errors';
import type { CallContext } from '@api/providers/port';
import type { HttpRequest, HttpResult, ProviderHttp } from '@api/providers/transport';

/** As much of a `fetch` response as is read here, so the demo can answer without a network stack. */
export interface WireResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type Wire = (
  url: string,
  init: { method: 'GET'; headers: Record<string, string>; signal: AbortSignal },
) => Promise<WireResponse>;

export const fetchWire: Wire = (url, init) => fetch(url, init);

/**
 * The only way the phone talks to a bank, and it can only read. A request that is not a GET, or that would go anywhere
 * but the one address it was made for, is refused before anything is sent: the token travels to the bank and nowhere
 * else, and this app has no way to move money.
 *
 * Nothing is logged or recorded: not the token, not the address, not the answer. A failure says what happened in
 * words that hold none of them.
 */
export class PhoneHttp {
  constructor(
    private readonly wire: Wire,
    /** Scheme and host with no trailing slash, for example `https://api.monobank.ua`. */
    private readonly origin: string,
  ) {}

  async request(_ctx: CallContext, spec: HttpRequest): Promise<HttpResult> {
    if (spec.method !== 'GET' || spec.json !== undefined || spec.form !== undefined) {
      throw new AppError('forbidden', 403, 'This app only reads from the bank.');
    }
    if (!spec.url.startsWith(`${this.origin}/`)) {
      throw new AppError('forbidden', 403, 'This app only talks to the bank it was set up for.');
    }

    const abort = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, spec.timeoutMs ?? 15_000);

    let response: WireResponse;
    let text: string;
    try {
      response = await this.wire(spec.url, {
        method: 'GET',
        headers: { accept: 'application/json', ...spec.headers },
        signal: abort.signal,
      });
      text = await response.text();
    } catch {
      // The cause is dropped on purpose: a network error's message can carry the address.
      throw new AppError(
        'bank_unavailable',
        503,
        timedOut ? 'The bank did not answer in time.' : 'The bank could not be reached.',
      );
    } finally {
      clearTimeout(timer);
    }

    let body: unknown;
    if (text && /^\s*[[{]/.test(text)) {
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    }
    const headers: Record<string, string> = {};
    const retry = response.headers.get('retry-after');
    if (retry) headers['retry-after'] = retry;

    return {
      status: response.status,
      ok: response.status >= 200 && response.status < 300,
      headers,
      body,
      text,
    };
  }

  /**
   * The adapter is typed against the server's HTTP class, of which it calls `request` and nothing else. That class
   * keeps private fields, so TypeScript will not take a look-alike without being told.
   */
  asProviderHttp(): ProviderHttp {
    return this as unknown as ProviderHttp;
  }
}
