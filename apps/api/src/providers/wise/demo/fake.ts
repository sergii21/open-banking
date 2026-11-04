import type { Clock } from '../../../clock';
import type { Transport } from '../../transport';

/** The only token the fake accepts. It is not a secret: it opens a fake. */
export const FAKE_WISE_TOKEN = 'wise-fake-personal-token-not-a-real-bank';
export const FAKE_WISE_PROFILE_ID = 14575282;

export interface FakeWiseOptions {
  clock: Clock;
  token?: string;
  /** Answer 429 with Retry-After to a request closer than this to the previous one. Null: no limit. */
  intervalMs?: number | null;
  latencyMs?: number;
}

export interface FakeReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const VERSION = '/2026Q4';

/**
 * A stand-in for api.wise.com, shaped by docs.wise.com (version 2026Q4): Bearer auth with the real 401 bodies (`invalid_token`,
 * `missing_token`), `GET /profiles`, `GET /profiles/{id}/balances?types=…` with numbers as JSON numbers, 429 with Retry-After, and
 * the SCA answer (`strongAuth`: 403 with X-2FA-Approval headers). It answers only GET; anything else is a 405 and is recorded in
 * `requests`, so a test can prove the app never sends one. There is no statement endpoint here on purpose: the app never asks.
 */
export class FakeWise {
  down = false;
  /** Balances answer 403 with the SCA headers, as Wise does when it wants strong authentication. */
  strongAuth = false;
  private lastCall: number | undefined;
  readonly requests: {
    method: string;
    path: string;
    query: string;
    headers: Record<string, string>;
    at: number;
  }[] = [];

  constructor(private readonly options: FakeWiseOptions) {}

  get token(): string {
    return this.options.token ?? FAKE_WISE_TOKEN;
  }

  setInterval(intervalMs: number | null): void {
    this.options.intervalMs = intervalMs;
  }

  handle(
    method: string,
    pathname: string,
    query: URLSearchParams,
    headers: Record<string, string>,
  ): FakeReply {
    const at = this.options.clock.now().getTime();
    this.requests.push({ method, path: pathname, query: query.toString(), headers, at });
    if (method !== 'GET') return { status: 405, body: { error: 'method_not_allowed' } };
    if (!pathname.startsWith(`${VERSION}/`)) return { status: 404, body: { error: 'not_found' } };

    const auth = headers['authorization'];
    if (!auth)
      return { status: 401, body: { error: 'missing_token', error_description: 'Missing token' } };
    if (auth !== `Bearer ${this.token}`) {
      return { status: 401, body: { error: 'invalid_token', error_description: 'Invalid token' } };
    }
    if (this.down) return { status: 503, body: { error: 'unavailable' } };
    const gap = this.options.intervalMs;
    if (gap && this.lastCall !== undefined && at - this.lastCall < gap) {
      return {
        status: 429,
        body: { error: 'too_many_requests' },
        headers: { 'retry-after': '1', 'x-rate-limited-by': 'wise-public-api' },
      };
    }
    this.lastCall = at;

    const rest = pathname.slice(VERSION.length);
    if (rest === '/profiles') {
      return {
        status: 200,
        body: [
          {
            type: 'PERSONAL',
            id: FAKE_WISE_PROFILE_ID,
            publicId: '00000000-0000-4000-8000-000000000001',
            userId: 9889627,
            address: {
              addressFirstLine: '1 Invented Street',
              city: 'Nowhere',
              countryIso2Code: 'BE',
              postCode: '1000',
            },
            email: 'made.up@example.com',
            currentState: 'VISIBLE',
            contactDetails: { email: 'made.up@example.com', phoneNumber: '+32000000000' },
            firstName: 'Made',
            lastName: 'Up',
            dateOfBirth: '1990-01-01',
            phoneNumber: '+32000000000',
            fullName: 'Made Up',
          },
        ],
      };
    }
    const balances = new RegExp(`^/profiles/${FAKE_WISE_PROFILE_ID}/balances$`).exec(rest);
    if (balances) {
      const types = (query.get('types') ?? '').split(',').filter(Boolean);
      if (types.length === 0) return { status: 400, body: { error: 'types is required' } };
      if (this.strongAuth) {
        return {
          status: 403,
          body: { error: 'forbidden' },
          headers: { 'x-2fa-approval': 'fake-one-time-token', 'x-2fa-approval-result': 'REJECTED' },
        };
      }
      const amount = (value: number, currency: string) => ({ value, currency });
      const balance = (
        id: number,
        currency: string,
        type: string,
        name: string | null,
        value: number,
      ) => ({
        id,
        currency,
        type,
        name,
        icon: null,
        investmentState: 'NOT_INVESTED',
        amount: amount(value, currency),
        reservedAmount: amount(0, currency),
        cashAmount: amount(value, currency),
        totalWorth: amount(value, currency),
        creationTime: '2024-01-10T10:00:00.000Z',
        modificationTime: '2026-11-01T10:00:00.000Z',
        visible: true,
      });
      const all = [
        balance(200001, 'EUR', 'STANDARD', null, 310.86),
        balance(200002, 'USD', 'STANDARD', null, 1204.5),
        balance(200003, 'GBP', 'STANDARD', null, 87.1),
        balance(200004, 'EUR', 'SAVINGS', 'Holiday', 2500),
      ];
      return { status: 200, body: all.filter((b) => types.includes(b.type)) };
    }
    return { status: 404, body: { error: 'not_found' } };
  }

  readonly transport: Transport = async (url, init) => {
    const latency = this.options.latencyMs ?? 0;
    if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency));
    const parsed = new URL(url);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    const reply = this.handle(
      (init.method ?? 'GET').toUpperCase(),
      parsed.pathname,
      parsed.searchParams,
      headers,
    );
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json; charset=utf-8', ...reply.headers },
    });
  };
}
