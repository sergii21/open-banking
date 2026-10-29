import { createHash, type JsonWebKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TrueLayerConfig } from '../src/config';
import {
  canonicalRequest,
  parseSignature,
  verifySignature,
} from '../src/providers/truelayer/signing';
import type { Transport } from '../src/providers/transport';

const FIXTURES = join(import.meta.dirname, 'fixtures/truelayer');

/** A fixture file, parsed. See fixtures/truelayer/README.md for where these come from. */
export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
}

export const TL_ACCOUNT_ID = '56c5ebe7d3b8b0e5e1f1c5b6a3a8c7d2';
export const TL_SAVINGS_ID = 'a14f2d9c7e3b4c58b6d1e0f7a9c2b3d4';

export function truelayerConfig(overrides: Partial<TrueLayerConfig> = {}): TrueLayerConfig {
  return {
    clientId: 'sandbox-ledgerlens-fixture',
    clientSecret: 'fixture-secret-never-real',
    dataProviders: 'uk-cs-mock',
    signing: null,
    beneficiary: { type: 'merchant_account', merchantAccountIds: {} },
    paymentProviders: { GBP: 'mock-payments-gb-redirect', EUR: 'mock-payments-de-redirect' },
    userEmail: 'demo@ledger-lens.example',
    ...overrides,
  };
}

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string | undefined;
  json: unknown;
  form: Record<string, string> | undefined;
}

export interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * A scripted TrueLayer. It speaks the documented wire format from the fixtures, remembers which tokens it issued so
 * that expiry and rotation behave like the real thing, and lets a test force one-off responses.
 */
export class TrueLayerStub {
  readonly requests: RecordedRequest[] = [];
  private readonly forced: { needle: string; reply: Reply }[] = [];
  private issued = 0;
  private validAccess: string | null = null;
  private validRefresh: string | null = null;
  private paymentTokens = 0;
  private validPayments: string | null = null;
  private signingKey: { kid: string; jwk: JsonWebKey } | null = null;
  private readonly payments = new Map<string, Record<string, unknown>>();
  private readonly idempotency = new Map<string, { digest: string; id: string }>();
  /** What the webhook key endpoint answers with. Tests publish the public half of the key they sign webhooks with. */
  jwks: JsonWebKey[] = [];

  /** Reply once to the next request whose "METHOD host/path" contains `needle`. */
  once(needle: string, reply: Reply): this {
    this.forced.push({ needle, reply });
    return this;
  }

  /** Make the access token the bank last issued stop working, as if it had expired there. */
  expireAccessToken(): void {
    this.validAccess = null;
  }

  /** The payments API now rejects the client-credentials token it last issued. */
  expirePaymentsToken(): void {
    this.validPayments = null;
  }

  /** The public half of the key the app signs payment requests with; the stub verifies every signature against it. */
  trustSigningKey(kid: string, publicKey: KeyObject): void {
    this.signingKey = { kid, jwk: publicKey.export({ format: 'jwk' }) };
  }

  /** Puts a payment (a fixture, optionally changed) where `GET /v3/payments/{id}` will find it. */
  setPayment(id: string, fixtureName: string, patch: Record<string, unknown> = {}): void {
    this.payments.set(id, { ...fixture<Record<string, unknown>>(fixtureName), id, ...patch });
  }

  paymentRequests(): RecordedRequest[] {
    return this.requests.filter(
      (r) => this.key(r) === 'POST api.truelayer-sandbox.com/v3/payments',
    );
  }

  count(needle: string): number {
    return this.requests.filter((r) => this.key(r).includes(needle)).length;
  }

  last(needle: string): RecordedRequest | undefined {
    return this.requests.findLast((r) => this.key(r).includes(needle));
  }

  private key(request: RecordedRequest): string {
    return `${request.method} ${request.url.host}${request.url.pathname}`;
  }

  private issueTokens(): Reply {
    this.issued += 1;
    this.validAccess = `tl_at_${String(this.issued).padStart(4, '0')}_fixture`;
    this.validRefresh = `tl_rt_${String(this.issued).padStart(4, '0')}_fixture`;
    return {
      status: 200,
      body: {
        ...fixture<object>('token.json'),
        access_token: this.validAccess,
        refresh_token: this.validRefresh,
      },
    };
  }

  private authorised(request: RecordedRequest): boolean {
    return (
      request.headers['authorization'] === `Bearer ${this.validAccess ?? ''}` &&
      this.validAccess !== null
    );
  }

  private route(request: RecordedRequest): Reply {
    const { pathname, host } = request.url;
    const key = this.key(request);

    if (key === 'POST auth.truelayer-sandbox.com/connect/token') {
      const body = (request.json ?? {}) as Record<string, string>;
      if (
        body['client_id'] !== 'sandbox-ledgerlens-fixture' ||
        body['client_secret'] !== 'fixture-secret-never-real'
      ) {
        return { status: 401, body: fixture('errors/invalid-client.json') };
      }
      if (body['grant_type'] === 'client_credentials') {
        if (body['scope'] !== 'payments') return { status: 400, body: { error: 'invalid_scope' } };
        this.paymentTokens += 1;
        this.validPayments = `tl_pt_${String(this.paymentTokens).padStart(4, '0')}_fixture`;
        return {
          status: 200,
          body: {
            access_token: this.validPayments,
            expires_in: 3600,
            token_type: 'Bearer',
            scope: 'payments',
          },
        };
      }
      if (body['grant_type'] === 'authorization_code') {
        return body['code'] === 'good-code' && body['code_verifier']
          ? this.issueTokens()
          : { status: 400, body: fixture('errors/invalid-grant.json') };
      }
      if (body['grant_type'] === 'refresh_token') {
        return body['refresh_token'] === this.validRefresh
          ? this.issueTokens()
          : { status: 400, body: fixture('errors/invalid-grant.json') };
      }
      return { status: 400, body: fixture('errors/invalid-grant.json') };
    }

    if (key === 'DELETE auth.truelayer-sandbox.com/api/delete') {
      return this.authorised(request)
        ? { status: 200 }
        : { status: 401, body: fixture('errors/invalid-token.json') };
    }

    if (host === 'api.truelayer-sandbox.com' && pathname.startsWith('/data/v1/')) {
      if (!this.authorised(request))
        return { status: 401, body: fixture('errors/invalid-token.json') };
      if (pathname === '/data/v1/me') return { status: 200, body: fixture('me.json') };
      if (pathname === '/data/v1/accounts') return { status: 200, body: fixture('accounts.json') };
      const match = /^\/data\/v1\/accounts\/([^/]+)\/(balance|transactions(?:\/pending)?)$/.exec(
        pathname,
      );
      if (match) {
        const [, id, resource] = match;
        const name = id === TL_ACCOUNT_ID ? 'transaction' : id === TL_SAVINGS_ID ? 'savings' : null;
        if (!name) return { status: 404, body: { error: 'account_not_found' } };
        if (resource === 'balance') return { status: 200, body: fixture(`balance-${name}.json`) };
        if (resource === 'transactions')
          return { status: 200, body: fixture(`transactions-${name}.json`) };
        return name === 'transaction'
          ? { status: 200, body: fixture('transactions-pending-transaction.json') }
          : { status: 501, body: fixture('errors/endpoint-not-supported.json') };
      }
    }
    if (key === 'GET webhooks.truelayer-sandbox.com/.well-known/jwks') {
      return { status: 200, body: { keys: this.jwks } };
    }

    if (host === 'api.truelayer-sandbox.com' && pathname.startsWith('/v3/payments')) {
      return this.routePayments(request, pathname);
    }

    return {
      status: 404,
      body: { error: 'not_found', error_description: `${key} is not scripted` },
    };
  }

  private routePayments(request: RecordedRequest, pathname: string): Reply {
    if (
      request.headers['authorization'] !== `Bearer ${this.validPayments ?? ''}` ||
      !this.validPayments
    ) {
      return { status: 401, body: fixture('payments/errors/unauthorized.json') };
    }

    if (request.method === 'GET') {
      const id = decodeURIComponent(pathname.slice('/v3/payments/'.length));
      const payment = this.payments.get(id);
      return payment
        ? { status: 200, body: payment }
        : { status: 404, body: { title: 'Not Found', status: 404 } };
    }

    if (request.method !== 'POST' || pathname !== '/v3/payments') {
      return { status: 404, body: { title: 'Not Found', status: 404 } };
    }

    // Like the real API: the request is refused unless the signature checks out against the registered public key.
    const idempotencyKey = request.headers['idempotency-key'];
    const signature = request.headers['tl-signature'];
    const parsed = signature ? parseSignature(signature) : null;
    const signed =
      parsed !== null &&
      this.signingKey !== null &&
      parsed.header.kid === this.signingKey.kid &&
      parsed.header.alg === 'ES512' &&
      idempotencyKey !== undefined &&
      verifySignature(
        this.signingKey.jwk,
        parsed,
        canonicalRequest(
          'POST',
          '/v3/payments',
          [['Idempotency-Key', idempotencyKey]],
          request.body ?? '',
        ),
      );
    if (!signed) {
      return {
        status: 401,
        body: {
          ...fixture<object>('payments/errors/unauthorized.json'),
          detail: 'Signature verification failed.',
        },
      };
    }

    const digest = createHash('sha256')
      .update(request.body ?? '')
      .digest('hex');
    const seen = this.idempotency.get(idempotencyKey);
    if (seen) {
      if (seen.digest !== digest) {
        return { status: 422, body: fixture('payments/errors/idempotency-conflict.json') };
      }
      return { status: 201, body: { ...fixture<object>('payments/created.json'), id: seen.id } };
    }

    const body = request.json as { amount_in_minor?: number; currency?: string } | undefined;
    if (!body?.amount_in_minor || !body.currency) {
      return { status: 400, body: fixture('payments/errors/invalid-parameters.json') };
    }
    const id = `0b1c2d3e-4f50-4a61-8b72-${String(this.payments.size + 1).padStart(12, '0')}`;
    this.idempotency.set(idempotencyKey, { digest, id });
    this.setPayment(id, 'payments/authorization-required.json', {
      amount_in_minor: body.amount_in_minor,
      currency: body.currency,
    });
    return { status: 201, body: { ...fixture<object>('payments/created.json'), id } };
  }

  readonly transport: Transport = (url, init) => {
    const target = new URL(url);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries((init.headers ?? {}) as Record<string, string>)) {
      headers[name.toLowerCase()] = value;
    }
    const body = typeof init.body === 'string' ? init.body : undefined;
    const contentType = headers['content-type'] ?? '';
    const request: RecordedRequest = {
      method: init.method ?? 'GET',
      url: target,
      headers,
      body,
      json: body && contentType.includes('json') ? (JSON.parse(body) as unknown) : undefined,
      form:
        body && contentType.includes('x-www-form-urlencoded')
          ? Object.fromEntries(new URLSearchParams(body))
          : undefined,
    };
    this.requests.push(request);

    const index = this.forced.findIndex((f) => this.key(request).includes(f.needle));
    const reply = index >= 0 ? this.forced.splice(index, 1)[0].reply : this.route(request);
    const payload = reply.body === undefined ? null : JSON.stringify(reply.body);
    return Promise.resolve(
      new Response(reply.status === 204 || payload === null ? null : payload, {
        status: reply.status,
        headers: { 'content-type': 'application/json', ...reply.headers },
      }),
    );
  };
}
