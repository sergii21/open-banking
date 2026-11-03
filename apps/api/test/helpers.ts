import { Calendar } from '../src/domain/calendar';
import { buildApp, type BuildAppOptions } from '../src/app';
import { fixedClock } from '../src/clock';
import { loadConfig } from '../src/config';
import { Db } from '../src/db/database';
import { DEMO_TOKEN, FakeMonobank, type FakeLimits } from '../src/providers/monobank/demo/fake';

export const NOW = '2026-11-03T10:00:00.000Z';
export const calendar = new Calendar('Europe/Kyiv');

export interface TestApp {
  app: Awaited<ReturnType<typeof buildApp>>['app'];
  ctx: Awaited<ReturnType<typeof buildApp>>['ctx'];
  clock: ReturnType<typeof fixedClock>;
  db: Db;
  close(): Promise<void>;
}

/** The whole app on an in-memory database and a clock you move by hand. Nothing leaves the process. */
export async function createTestApp(
  env: Record<string, string> = {},
  options: Partial<BuildAppOptions> = {},
): Promise<TestApp> {
  const clock = options.clock ? (options.clock as ReturnType<typeof fixedClock>) : fixedClock(NOW);
  const db = new Db(':memory:');
  const config = loadConfig({ NODE_ENV: 'test', DATABASE_PATH: ':memory:', ...env });
  const { app, ctx } = await buildApp({ config, clock, db, ...options });
  await app.ready();
  return {
    app,
    ctx,
    clock,
    db,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}

/** A fake monobank that enforces the bank's one-read-a-minute limit, for the live provider's transport. */
export function paced(
  clock: ReturnType<typeof fixedClock>,
  limits: FakeLimits | null = null,
): FakeMonobank {
  return new FakeMonobank({ clock, calendar, token: DEMO_TOKEN, limits });
}

/** A browser as far as the API can tell: it keeps the cookies and sends the CSRF token a real page would. */
export class Client {
  private cookies = new Map<string, string>();
  constructor(private readonly t: TestApp) {}

  private headers(write: boolean): Record<string, string> {
    const cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    return {
      ...(cookie ? { cookie } : {}),
      ...(write
        ? {
            'x-xsrf-token': this.cookies.get('XSRF-TOKEN') ?? '',
            origin: this.t.ctx.config.publicUrl,
          }
        : {}),
    };
  }

  private remember(setCookie: unknown): void {
    for (const raw of [setCookie].flat()) {
      if (typeof raw !== 'string') continue;
      const [pair = ''] = raw.split(';');
      const eq = pair.indexOf('=');
      this.cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  }

  async request(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown) {
    const response = await this.t.app.inject({
      method,
      url,
      headers: this.headers(method !== 'GET'),
      ...(body === undefined ? {} : { payload: body as object }),
    });
    this.remember(response.headers['set-cookie']);
    return response;
  }

  get = (url: string) => this.request('GET', url);
  post = (url: string, body?: unknown) => this.request('POST', url, body ?? {});
  put = (url: string, body?: unknown) => this.request('PUT', url, body);
  patch = (url: string, body?: unknown) => this.request('PATCH', url, body);
  delete = (url: string) => this.request('DELETE', url);

  async start(): Promise<void> {
    await this.get('/api/session');
  }
}

export { DEMO_TOKEN };
