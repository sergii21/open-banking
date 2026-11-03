import type { InspectorCall, ProviderId, ProviderMode } from '@ledger-lens/contracts';
import type { Clock } from '../clock';
import { newId } from '../domain/crypto';
import { redactHeaders, redactJson, redactUrl, truncateJson } from '../domain/redact';
import { AppError } from '../errors';
import type { InspectorStore } from '../modules/inspector/inspector-store';
import type { CallContext } from './port';

/** The wire. Production adapters use `fetch`; tests and the mock bank plug in their own. */
export type Transport = (url: string, init: RequestInit) => Promise<Response>;

export const fetchTransport: Transport = (url, init) => fetch(url, init);

export interface HttpRequest {
  /** What the Inspector shows, for example `Fetch accounts`. */
  label: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  json?: unknown;
  /** application/x-www-form-urlencoded body (OAuth token endpoints). */
  form?: Record<string, string>;
  /**
   * Called with the exact bytes about to be sent; the returned headers are added to the request. Request signing needs
   * this because the signature covers the serialised body, which only this class knows.
   */
  sign?: (body: string) => Record<string, string>;
  timeoutMs?: number;
}

export interface HttpResult {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  /** Parsed JSON when the body is JSON, otherwise undefined. */
  body: unknown;
  text: string;
}

export interface ProviderHttpOptions {
  provider: ProviderId;
  mode: ProviderMode;
  transport: Transport;
  inspector: InspectorStore;
  clock: Clock;
}

/**
 * The only way adapters talk HTTP. Every call is timed, redacted and filed with the Inspector, and network
 * failures become `bank_unavailable`. Non-2xx responses are returned, not thrown: mapping a status to a domain
 * error is the adapter's job because the meaning of 401/403/429 differs per provider.
 */
export class ProviderHttp {
  constructor(private readonly options: ProviderHttpOptions) {}

  async request(ctx: CallContext, spec: HttpRequest): Promise<HttpResult> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'user-agent': 'LedgerLens/0.1 (+open-banking-poc)',
      ...spec.headers,
    };
    let body: string | undefined;
    if (spec.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(spec.json);
    } else if (spec.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(spec.form).toString();
    }
    if (spec.sign) Object.assign(headers, spec.sign(body ?? ''));

    const started = performance.now();
    const at = this.options.clock.now().toISOString();
    const redactOptions = { maskIdentifiers: this.options.mode === 'live' };
    const recordBase = {
      id: newId('call'),
      at,
      provider: this.options.provider,
      label: spec.label,
      direction: 'outbound' as const,
      method: spec.method,
      url: redactUrl(spec.url, redactOptions),
      connectionId: ctx.connectionId,
    };
    const requestSummary = {
      headers: redactHeaders(headers),
      body: truncateJson(redactJson(spec.json ?? spec.form ?? null, redactOptions)).value,
    };

    let response: Response;
    let text: string;
    try {
      response = await this.options.transport(spec.url, {
        method: spec.method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.timeout(spec.timeoutMs ?? 15_000),
      });
      text = await response.text();
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
      this.options.inspector.record(ctx.sessionId, {
        ...recordBase,
        status: null,
        durationMs: Math.round(performance.now() - started),
        request: requestSummary,
        response: null,
        error: timedOut ? 'Timed out' : 'Network error',
        truncated: false,
      });
      throw new AppError(
        'bank_unavailable',
        503,
        timedOut ? 'The bank did not answer in time.' : 'The bank could not be reached.',
        { cause: error },
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    let parsed: unknown;
    if (text && (contentType.includes('json') || /^\s*[[{]/.test(text))) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    const responseHeaders: Record<string, string> = {};
    for (const name of ['content-type', 'retry-after', 'x-request-id', 'x-correlation-id']) {
      const value = response.headers.get(name);
      if (value) responseHeaders[name] = value;
    }

    const shownBody =
      parsed === undefined ? (text ? text.slice(0, 400) : null) : redactJson(parsed, redactOptions);
    const { value: truncatedBody, truncated } = truncateJson(shownBody);

    const call: InspectorCall = {
      ...recordBase,
      status: response.status,
      durationMs: Math.round(performance.now() - started),
      request: requestSummary,
      response: { headers: redactHeaders(responseHeaders), body: truncatedBody },
      error: null,
      truncated,
    };
    this.options.inspector.record(ctx.sessionId, call);

    return {
      status: response.status,
      ok: response.ok,
      headers: responseHeaders,
      body: parsed,
      text,
    };
  }
}
