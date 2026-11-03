import type { Clock } from '../../../clock';
import { type Calendar } from '../../../domain/calendar';
import type { Transport } from '../../transport';
import { buildDataset, type Dataset } from './dataset';

/** The only token the fake bank accepts. It is not a secret: it opens a fake. */
export const DEMO_TOKEN = 'demo-token-ledger-lens-not-a-real-bank';

export interface FakeLimits {
  statementMs: number;
  infoMs: number;
  /** One bucket for both endpoints: the spec does not say which way the real bank counts, so the tests try both. */
  shared?: boolean;
}

export interface FakeMonobankOptions {
  clock: Clock;
  calendar: Calendar;
  token?: string;
  /** Enforce monobank's one-read-a-minute limits with a 429. The in-process demo does not; the stand-alone fake does. */
  limits?: FakeLimits | null;
  /** Pretend the network takes this long, so loading states are visible and realistic. */
  latencyMs?: number;
  seed?: number;
  /** How many days of history the made-up customer has (default 100); more makes a bigger list to try the app on. */
  historyDays?: number;
}

export interface FakeReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const MAX_ITEMS = 500;
const MAX_RANGE_SECONDS = 2_682_000;

/** Rates the way /bank/currency publishes them: some pairs have buy and sell, some only a cross rate. */
function fakeRates(nowSeconds: number): unknown[] {
  const date = nowSeconds - 420;
  return [
    { currencyCodeA: 840, currencyCodeB: 980, date, rateBuy: 41.15, rateSell: 41.6 },
    { currencyCodeA: 978, currencyCodeB: 980, date, rateBuy: 47.9, rateSell: 48.5 },
    { currencyCodeA: 978, currencyCodeB: 840, date, rateBuy: 1.162, rateSell: 1.172 },
    { currencyCodeA: 826, currencyCodeB: 980, date, rateCross: 55.2 },
    { currencyCodeA: 985, currencyCodeB: 980, date, rateCross: 11.2 },
    { currencyCodeA: 756, currencyCodeB: 980, date, rateCross: 51.3 },
    { currencyCodeA: 203, currencyCodeB: 980, date, rateCross: 1.98 },
  ];
}

/**
 * A stand-in for api.monobank.ua: the same paths, headers, status codes and field names, with a Ukrainian customer's
 * data. The demo adapter talks to it in-process; `server.ts` serves it over HTTP for browser runs and tests that want
 * the real pacing.
 */
export class FakeMonobank {
  /** Everything but the public rates answers 503 while this is on (a bank outage). */
  down = false;
  private data: Dataset | null = null;
  private dataDay = '';
  private readonly lastCall = new Map<string, number>();

  constructor(private readonly options: FakeMonobankOptions) {}

  get token(): string {
    return this.options.token ?? DEMO_TOKEN;
  }

  setLimits(limits: FakeLimits | null): void {
    this.options.limits = limits;
  }

  private dataset(): Dataset {
    const now = this.options.clock.now();
    const day = this.options.calendar.today(now);
    if (!this.data || this.dataDay !== day) {
      this.data = buildDataset(
        now,
        this.options.calendar,
        this.options.seed,
        this.options.historyDays,
      );
      this.dataDay = day;
    }
    return this.data;
  }

  private throttled(endpoint: 'client-info' | 'statement'): FakeReply | null {
    const limits = this.options.limits;
    if (!limits) return null;
    const gap = endpoint === 'statement' ? limits.statementMs : limits.infoMs;
    const now = this.options.clock.now().getTime();
    const bucket = limits.shared ? 'any' : endpoint;
    const last = this.lastCall.get(bucket);
    if (last !== undefined && now - last < gap) {
      return { status: 429, body: { errorDescription: 'Too many requests' } };
    }
    this.lastCall.set(bucket, now);
    return null;
  }

  handle(method: string, pathname: string, token: string | undefined): FakeReply {
    const now = this.options.clock.now();
    if (method !== 'GET') return { status: 405, body: { errorDescription: 'Method not allowed' } };

    if (pathname === '/bank/currency') {
      return { status: 200, body: fakeRates(Math.floor(now.getTime() / 1000)) };
    }
    if (!pathname.startsWith('/personal/')) {
      return { status: 404, body: { errorDescription: 'Not found' } };
    }
    if (token !== this.token) {
      return { status: 403, body: { errorDescription: "Unknown 'X-Token'" } };
    }
    if (this.down) return { status: 503, body: { errorDescription: 'Service unavailable' } };

    const data = this.dataset();
    if (pathname === '/personal/client-info') {
      const limited = this.throttled('client-info');
      if (limited) return limited;
      return {
        status: 200,
        body: {
          clientId: data.clientId,
          name: data.name,
          webHookUrl: '',
          permissions: 'psj',
          accounts: data.accounts,
          jars: data.jars,
        },
      };
    }

    const match = /^\/personal\/statement\/([^/]+)\/(\d+)(?:\/(\d+))?$/.exec(pathname);
    if (!match) return { status: 404, body: { errorDescription: 'Not found' } };
    const limited = this.throttled('statement');
    if (limited) return limited;

    const id = decodeURIComponent(match[1] ?? '');
    const from = Number(match[2]);
    const to = match[3] ? Number(match[3]) : Math.floor(now.getTime() / 1000);
    if (to - from > MAX_RANGE_SECONDS || to <= from) {
      return { status: 400, body: { errorDescription: 'Invalid period' } };
    }
    const accountId = id === '0' ? data.accounts[0]?.id : id;
    const list = accountId ? data.items.get(accountId) : undefined;
    if (!list) return { status: 400, body: { errorDescription: 'Unknown account' } };
    return {
      status: 200,
      body: list.filter((item) => item.time >= from && item.time <= to).slice(0, MAX_ITEMS),
    };
  }

  /** The adapter's transport: no sockets, just a function from request to response. */
  readonly transport: Transport = async (url, init) => {
    const latency = this.options.latencyMs ?? 0;
    if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency));
    const headers = new Headers(init.headers);
    const reply = this.handle(
      (init.method ?? 'GET').toUpperCase(),
      new URL(url).pathname,
      headers.get('x-token') ?? undefined,
    );
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json; charset=utf-8', ...reply.headers },
    });
  };
}
