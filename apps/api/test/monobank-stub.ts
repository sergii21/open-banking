import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Transport } from '../src/providers/transport';

const FIXTURES = join(import.meta.dirname, 'fixtures/monobank');

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
}

export const MONO_TOKEN = 'uTestTokenForFixturesOnly_0001abcdef';
export const MONO_CARD = 'kKGVoZuHWzqVoZuH';

const MIN_GAP_MS = 60_000;
const MAX_RANGE_SECONDS = 2_682_000;

export interface MonoRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  /** When the stub saw it, by the test clock. */
  at: number;
}

interface Statement {
  id: string;
  time: number;
  [field: string]: unknown;
}

/**
 * A scripted monobank personal API. It enforces the rules the real service enforces and that matter to us: a token check,
 * one request per minute per endpoint (429 otherwise), a 31-day statement window and a 500-row cap, newest first.
 */
export class MonobankStub {
  readonly requests: MonoRequest[] = [];
  validToken = MONO_TOKEN;
  /** Replaces the card statement, newest first. */
  statementRows: Statement[] | null = null;

  private now: () => number = () => Date.now();
  private readonly accepted = new Map<string, number>();
  private readonly forced: {
    needle: string;
    status: number;
    body: unknown;
    headers?: Record<string, string>;
  }[] = [];

  useClock(clock: { now(): Date }): void {
    this.now = () => clock.now().getTime();
  }

  once(needle: string, status: number, body: unknown, headers?: Record<string, string>): this {
    this.forced.push({ needle, status, body, ...(headers ? { headers } : {}) });
    return this;
  }

  count(needle: string): number {
    return this.requests.filter((r) => this.key(r).includes(needle)).length;
  }

  statements(): MonoRequest[] {
    return this.requests.filter((r) => r.url.pathname.startsWith('/personal/statement/'));
  }

  private key(request: Pick<MonoRequest, 'method' | 'url'>): string {
    return `${request.method} ${request.url.host}${request.url.pathname}`;
  }

  private reply(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    });
  }

  private route(request: MonoRequest): Response {
    const { pathname } = request.url;
    if (request.headers['x-token'] !== this.validToken) {
      return this.reply(403, fixture('unknown-token.json'));
    }
    const kind = pathname.startsWith('/personal/statement/') ? 'statement' : pathname;
    const last = this.accepted.get(kind);
    if (last !== undefined && request.at - last < MIN_GAP_MS) {
      return this.reply(429, { errorDescription: 'Too many requests' });
    }
    this.accepted.set(kind, request.at);

    if (pathname === '/personal/client-info') return this.reply(200, fixture('client-info.json'));

    const match = /^\/personal\/statement\/([^/]+)\/(\d+)\/(\d+)$/.exec(pathname);
    if (match) {
      const [, id, fromText, toText] = match;
      const from = Number(fromText);
      const to = Number(toText);
      if (to - from > MAX_RANGE_SECONDS) {
        return this.reply(400, { errorDescription: 'Too long period' });
      }
      const source =
        id === MONO_CARD
          ? (this.statementRows ?? fixture<Statement[]>('statement-black.json'))
          : [];
      const rows = source.filter((row) => row.time >= from && row.time <= to).slice(0, 500);
      return this.reply(200, rows);
    }
    return this.reply(404, { errorDescription: `${pathname} is not scripted` });
  }

  readonly transport: Transport = (url, init) => {
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[name.toLowerCase()] = value;
    }
    const request: MonoRequest = {
      method: init.method ?? 'GET',
      url: new URL(url),
      headers,
      at: this.now(),
    };
    this.requests.push(request);

    const index = this.forced.findIndex((f) => this.key(request).includes(f.needle));
    if (index >= 0) {
      const forced = this.forced.splice(index, 1)[0];
      return Promise.resolve(this.reply(forced.status, forced.body, forced.headers));
    }
    return Promise.resolve(this.route(request));
  };
}
