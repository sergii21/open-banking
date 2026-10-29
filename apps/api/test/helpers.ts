import { randomUUID } from 'node:crypto';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp, type BuiltApp } from '../src/app';
import { fixedClock } from '../src/clock';
import { loadConfig, type AppConfig } from '../src/config';
import { Db } from '../src/db/database';
import type { ProviderTransports } from '../src/providers/registry';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = loadConfig({
    NODE_ENV: 'test',
    DATABASE_PATH: ':memory:',
    LOG_LEVEL: 'silent',
    PROVIDERS: 'mock',
    PUBLIC_URL: 'http://localhost:4200',
  });
  return { ...base, ...overrides };
}

export interface TestApp extends BuiltApp {
  db: Db;
  clock: ReturnType<typeof fixedClock>;
  close(): Promise<void>;
}

/** A fully wired app on an in-memory database and a controllable clock. */
export async function createTestApp(
  overrides: Partial<AppConfig> = {},
  clockIso = '2026-10-28T10:00:00.000Z',
  transports?: ProviderTransports,
): Promise<TestApp> {
  const clock = fixedClock(clockIso);
  const db = new Db(':memory:');
  const built = await buildApp({
    config: testConfig(overrides),
    clock,
    db,
    ...(transports ? { transports } : {}),
  });
  await built.app.ready();
  return {
    ...built,
    db,
    clock,
    close: async () => {
      await built.app.close();
      db.close();
    },
  };
}

// ----------------------------------------------------------------------------------------------- client

const unescapeHtml = (value: string): string =>
  value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

export function hiddenFields(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
    fields[unescapeHtml(match[1])] = unescapeHtml(match[2]);
  }
  return fields;
}

export interface RequestOptions {
  payload?: unknown;
  headers?: Record<string, string>;
  /** The caller's address as the server sees it (`request.ip`). */
  remoteAddress?: string;
  /** Send the XSRF header (default for mutating calls). */
  csrf?: boolean;
}

/** A browser stand-in: keeps cookies and echoes the XSRF cookie into the header like Angular does. */
export class Client {
  readonly cookies = new Map<string, string>();

  constructor(private readonly t: TestApp) {}

  private store(response: LightMyRequestResponse): void {
    for (const cookie of response.cookies) {
      if (cookie.value === '' || (cookie.maxAge !== undefined && cookie.maxAge <= 0)) {
        this.cookies.delete(cookie.name);
      } else {
        this.cookies.set(cookie.name, cookie.value);
      }
    }
  }

  private cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  async request(
    method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
    url: string,
    options: RequestOptions = {},
  ) {
    const headers: Record<string, string> = { ...options.headers };
    if (this.cookies.size > 0) headers['cookie'] = this.cookieHeader();
    const token = this.cookies.get('XSRF-TOKEN');
    if (method !== 'GET' && options.csrf !== false && token) headers['x-xsrf-token'] = token;

    const isForm = typeof options.payload === 'string';
    const response = await this.t.app.inject({
      method,
      url,
      headers: isForm
        ? { 'content-type': 'application/x-www-form-urlencoded', ...headers }
        : headers,
      ...(options.payload === undefined ? {} : { payload: options.payload as string | object }),
      ...(options.remoteAddress ? { remoteAddress: options.remoteAddress } : {}),
    });
    this.store(response);
    return response;
  }

  /** Sends a payment-creating request with an Idempotency-Key (a fresh one unless given). */
  createPayment(payload: unknown, key: string | null = randomUUID()) {
    return this.post(
      '/api/payments',
      payload,
      key === null ? {} : { headers: { 'idempotency-key': key } },
    );
  }

  /**
   * Walks the mock bank's hosted payment page like a browser: open the link, choose who pays and what happens, press the
   * button, follow the bank's redirect to the app's return endpoint, and follow that to the page it names.
   */
  async payAtBank(
    authUrl: string,
    options: { persona?: string; outcome?: string; decision?: 'approve' | 'cancel' } = {},
  ): Promise<{ bankLocation: string; resultPath: string }> {
    const link = new URL(authUrl);
    const page = await this.t.app.inject({ method: 'GET', url: `${link.pathname}${link.search}` });
    if (page.statusCode !== 200) throw new Error(`payment page: ${page.statusCode} ${page.body}`);

    const decision = await this.t.app.inject({
      method: 'POST',
      url: '/mock-bank/pay/decision',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        ...hiddenFields(page.body),
        persona: options.persona ?? 'anna',
        outcome: options.outcome ?? 'test_executed',
        decision: options.decision ?? 'approve',
      }).toString(),
    });
    if (decision.statusCode !== 302)
      throw new Error(`decision: ${decision.statusCode} ${decision.body}`);
    const bankLocation = decision.headers['location'] as string;

    const back = new URL(bankLocation);
    const returned = await this.get(`${back.pathname}${back.search}`);
    return { bankLocation, resultPath: returned.headers['location'] as string };
  }

  get = (url: string, options?: RequestOptions) => this.request('GET', url, options);
  post = (url: string, payload?: unknown, options: RequestOptions = {}) =>
    this.request('POST', url, { ...options, payload });
  delete = (url: string, options?: RequestOptions) => this.request('DELETE', url, options);

  async startSession() {
    const response = await this.get('/api/session');
    if (response.statusCode !== 200)
      throw new Error(`session bootstrap failed: ${response.statusCode}`);
    return response.json<{ id: string }>();
  }

  /** Walks the real hosted journey: authorize page, sign-in, consent review, decision, callback. */
  async connectBank(
    options: {
      institutionId?: string;
      persona?: string;
      decision?: 'allow' | 'deny';
    } = {},
  ): Promise<{
    connectionId: string;
    location: string;
    status: string;
    connection: string | null;
  }> {
    const start = await this.post('/api/connections', {
      institutionId: options.institutionId ?? 'mock:mock-bank',
    });
    if (start.statusCode !== 201)
      throw new Error(`start failed: ${start.statusCode} ${start.body}`);
    const { connectionId, authUrl } = start.json<{ connectionId: string; authUrl: string }>();

    const authorize = new URL(authUrl);
    const signIn = await this.t.app.inject({
      method: 'GET',
      url: `${authorize.pathname}${authorize.search}`,
    });
    if (signIn.statusCode !== 200) throw new Error(`authorize page: ${signIn.statusCode}`);

    const afterSignIn = await this.t.app.inject({
      method: 'POST',
      url: '/mock-bank/auth/signin',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        ...hiddenFields(signIn.body),
        persona: options.persona ?? 'anna',
      }).toString(),
    });
    // Outage persona: the bank answers 503 and offers a link back to the app.
    if (afterSignIn.statusCode === 503) {
      const back =
        /href="([^"]+)"/.exec(afterSignIn.body.split('class="button secondary"')[1] ?? '')?.[1] ??
        '';
      return this.finish(connectionId, unescapeHtml(back));
    }

    const decision = await this.t.app.inject({
      method: 'POST',
      url: '/mock-bank/auth/decision',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        ...hiddenFields(afterSignIn.body),
        decision: options.decision ?? 'allow',
      }).toString(),
    });
    // SCA timeout persona: a waiting page whose meta refresh target is the timeout redirect.
    if (decision.statusCode === 200) {
      const refresh =
        /http-equiv="refresh" content="\d+;url=([^"]+)"/.exec(decision.body)?.[1] ?? '';
      return this.finish(connectionId, unescapeHtml(refresh));
    }
    return this.finish(connectionId, decision.headers['location'] as string);
  }

  private async finish(connectionId: string, callbackUrl: string) {
    const callback = new URL(callbackUrl);
    const response = await this.t.app.inject({
      method: 'GET',
      url: `${callback.pathname}${callback.search}`,
      headers: this.cookies.size > 0 ? { cookie: this.cookieHeader() } : {},
    });
    const location = response.headers['location'] as string;
    const result = new URL(location, 'http://localhost');
    return {
      connectionId,
      location,
      status: result.searchParams.get('status') ?? '',
      connection: result.searchParams.get('connection'),
    };
  }
}

export async function newClient(t: TestApp): Promise<Client> {
  const client = new Client(t);
  await client.startSession();
  return client;
}
