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
 * the SCA answer (`strongAuth`: 403 with X-2FA-Approval headers). For drafts: `GET /accounts`, `POST /profiles/{id}/quotes`,
 * `POST /transfers` (idempotent on `customerTransactionId`, a quote used once, the created transfer's `sourceValue` 0 as in Wise's
 * sample), `GET /transfers`. The funding call answers as Wise would, so a bug that sent it would succeed here and show up in
 * `requests`, where a test looks for it. Any other write is a 405. There is no statement endpoint: the app never asks.
 */
export class FakeWise {
  down = false;
  /** Balances answer 403 with the SCA headers, as Wise does when it wants strong authentication. */
  strongAuth = false;
  /** The token may read but not write: quotes and transfers answer a plain 403. */
  writesForbidden = false;
  /** Wise's words when a business account has payment approvals on. */
  needsApproval = false;
  /** How many saved recipients beyond the three named ones. */
  extraRecipients = 0;
  private readonly quotes = new Map<
    string,
    { used: boolean; recipient: number; target: string; targetValue: number }
  >();
  private readonly transfers = new Map<string, Record<string, unknown>>();
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
    body?: unknown,
  ): FakeReply {
    const at = this.options.clock.now().getTime();
    this.requests.push({ method, path: pathname, query: query.toString(), headers, at });
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
    if (method !== 'GET') return this.write(method, rest, body);
    if (rest === '/accounts') return this.accounts(query);
    if (rest === '/transfers') {
      const waiting = [...this.transfers.values()].filter(
        (t) => t['status'] === query.get('status'),
      );
      return { status: 200, body: waiting };
    }
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

  private accounts(query: URLSearchParams): FakeReply {
    if (query.get('profileId') !== String(FAKE_WISE_PROFILE_ID)) {
      return { status: 200, body: { content: [], seekPositionForNext: 0, size: 20 } };
    }
    const recipient = (id: number, fullName: string, currency: string, summary: string) => ({
      id,
      name: { fullName },
      currency,
      country: 'GB',
      type: 'sort_code',
      active: true,
      accountSummary: summary,
      longAccountSummary: `${currency} account ending ${summary.slice(-4)} of ${fullName}`,
      displayFields: [{ key: 'accountNumber', label: 'Account number', value: '12345678' }],
      ownedByCustomer: false,
      hash: 'made-up-hash',
      profileId: FAKE_WISE_PROFILE_ID,
    });
    const all = [
      recipient(700001, 'Olena Vigada', 'GBP', '(23-14-70) 12345678'),
      recipient(700002, 'Taras Made-Up', 'EUR', 'BE68 •••• 0794'),
      { ...recipient(700003, 'Closed Account', 'EUR', 'BE11 •••• 0000'), active: false },
      ...Array.from({ length: this.extraRecipients }, (_, i) =>
        recipient(710000 + i, `Extra ${i}`, 'USD', `(0) ${i}`),
      ),
    ];
    const from = Number(query.get('seekPosition') ?? 0);
    const size = Number(query.get('size') ?? 20);
    const content = all.slice(from, from + size);
    return { status: 200, body: { content, seekPositionForNext: from + content.length, size } };
  }

  private write(method: string, rest: string, body: unknown): FakeReply {
    if (method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } };
    const funding = /^\/profiles\/\d+\/transfers\/\d+\/payments$/.exec(rest);
    if (funding) return { status: 201, body: { type: 'BALANCE', status: 'COMPLETED' } };
    const isQuote = rest === `/profiles/${FAKE_WISE_PROFILE_ID}/quotes`;
    if (!isQuote && rest !== '/transfers')
      return { status: 405, body: { error: 'method_not_allowed' } };
    if (this.writesForbidden) return { status: 403, body: { error: 'forbidden' } };
    return isQuote ? this.quote(body) : this.transfer(body);
  }

  private quote(body: unknown): FakeReply {
    const input = body as {
      sourceCurrency?: string;
      targetCurrency?: string;
      sourceAmount?: number;
      targetAccount?: number;
    };
    if (
      !input.sourceCurrency ||
      !input.targetCurrency ||
      !input.sourceAmount ||
      !input.targetAccount
    ) {
      return { status: 422, body: { errors: [{ code: 'invalid', message: 'Missing a field.' }] } };
    }
    const id = `11144c35-9fe8-4c32-b7fd-${String(this.quotes.size + 1).padStart(12, '0')}`;
    const rate = input.sourceCurrency === input.targetCurrency ? 1 : 0.85;
    const fee = Math.round(input.sourceAmount * 0.5) / 100;
    const targetAmount = Math.round((input.sourceAmount - fee) * rate * 100) / 100;
    this.quotes.set(id, {
      used: false,
      recipient: input.targetAccount,
      target: input.targetCurrency,
      targetValue: targetAmount,
    });
    const option = (payIn: string, disabled: boolean) => ({
      payIn,
      payOut: 'BANK_TRANSFER',
      sourceAmount: input.sourceAmount,
      targetAmount,
      fee: { total: fee },
      disabled,
      price: { total: { value: { amount: fee, currency: input.sourceCurrency } } },
    });
    return {
      status: 200,
      body: {
        id,
        sourceCurrency: input.sourceCurrency,
        targetCurrency: input.targetCurrency,
        sourceAmount: input.sourceAmount,
        targetAmount,
        payOut: 'BANK_TRANSFER',
        preferredPayIn: 'BALANCE',
        rate,
        expirationTime: new Date(this.options.clock.now().getTime() + 1_800_000).toISOString(),
        paymentOptions: [option('BANK_TRANSFER', false), option('BALANCE', false)],
      },
    };
  }

  private transfer(body: unknown): FakeReply {
    const input = body as {
      targetAccount?: number;
      quoteUuid?: string;
      customerTransactionId?: string;
      details?: { reference?: string };
    };
    if (!input.customerTransactionId) {
      return { status: 422, body: { errors: [{ code: 'invalid', message: 'Missing an id.' }] } };
    }
    const repeat = this.transfers.get(input.customerTransactionId);
    if (repeat) return { status: 200, body: repeat };
    if (this.needsApproval) {
      return {
        status: 422,
        body: {
          errors: [
            {
              code: 'error.approval',
              message: 'Quote cannot be accepted with this request due to missing approval',
            },
          ],
        },
      };
    }
    const quote = this.quotes.get(input.quoteUuid ?? '');
    if (!quote || quote.used || quote.recipient !== input.targetAccount) {
      return {
        status: 422,
        body: { errors: [{ code: 'quote', message: 'This quote cannot be used.' }] },
      };
    }
    quote.used = true;
    const transfer = {
      id: 16_521_632 + this.transfers.size,
      user: 9889627,
      targetAccount: input.targetAccount,
      sourceAccount: null,
      quoteUuid: input.quoteUuid,
      status: 'incoming_payment_waiting',
      reference: input.details?.reference ?? '',
      rate: 0.85,
      created: this.options.clock.now().toISOString().slice(0, 19).replace('T', ' '),
      details: { reference: input.details?.reference ?? '' },
      hasActiveIssues: false,
      sourceCurrency: 'EUR',
      sourceValue: 0,
      targetCurrency: quote.target,
      targetValue: quote.targetValue,
      customerTransactionId: input.customerTransactionId,
      payinSessionId: '23330542-8e9e-419f-95eb-312b880f92ad',
    };
    this.transfers.set(input.customerTransactionId, transfer);
    return { status: 200, body: transfer };
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
      typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    );
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json; charset=utf-8', ...reply.headers },
    });
  };
}
