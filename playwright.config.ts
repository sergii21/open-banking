import { defineConfig, devices } from '@playwright/test';

const PORT = 4300;
// A second copy of the app with the real monobank and PrivatBank providers pointed at local fakes of their APIs, which enforce
// the banks' limits (monobank's one read a minute shortened to a few seconds so a test can watch the pacing; PrivatBank's
// one request a second as it is).
const LIVE_PORT = 4301;
const FAKE_PORT = 4310;
const FAKE_PRIVAT_PORT = 4311;
const FAKE_WISE_PORT = 4312;

// Set PLAYWRIGHT_BASE_URL to run against a server you started yourself (for example `npm run app`). Otherwise Playwright
// starts the built app on its own port, backed by an in-memory database and the demo bank, so runs are deterministic and
// never touch your data.
const externalBaseUrl = process.env['PLAYWRIGHT_BASE_URL'];
const baseURL = externalBaseUrl ?? `http://localhost:${PORT}`;
const liveBaseURL = `http://localhost:${LIVE_PORT}`;

const appEnv = (port: number, extra: Record<string, string> = {}) => ({
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  PORT: String(port),
  PUBLIC_URL: `http://localhost:${port}`,
  DATABASE_PATH: ':memory:',
  LOG_LEVEL: 'warn',
  RATE_LIMIT_PER_MINUTE: '100000',
  SESSION_CREATES_PER_MINUTE: '100000',
  DEMO_REAL_RATES: 'false',
  ...extra,
});

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: process.env['CI'] ? 2 : undefined,
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: { baseURL, trace: 'on-first-retry' },
  webServer: externalBaseUrl
    ? undefined
    : [
        {
          command: 'node apps/api/dist/server.js',
          url: `${baseURL}/readyz`,
          reuseExistingServer: !process.env['CI'],
          timeout: 60_000,
          env: appEnv(PORT),
        },
        {
          command: 'npx tsx apps/api/src/providers/monobank/demo/server.ts',
          url: `http://127.0.0.1:${FAKE_PORT}/health`,
          // Never adopt whatever happens to listen there: another app answering 200 would pass for the fake bank.
          reuseExistingServer: false,
          timeout: 60_000,
          env: { FAKE_MONOBANK_PORT: String(FAKE_PORT), FAKE_MONOBANK_INTERVAL_SECONDS: '4' },
        },
        {
          command: 'npx tsx apps/api/src/providers/privatbank/demo/server.ts',
          url: `http://127.0.0.1:${FAKE_PRIVAT_PORT}/health`,
          reuseExistingServer: false,
          timeout: 60_000,
          env: {
            FAKE_PRIVATBANK_PORT: String(FAKE_PRIVAT_PORT),
            FAKE_PRIVATBANK_INTERVAL_MS: '1000',
          },
        },
        {
          command: 'npx tsx apps/api/src/providers/wise/demo/server.ts',
          url: `http://127.0.0.1:${FAKE_WISE_PORT}/health`,
          reuseExistingServer: false,
          timeout: 60_000,
          env: { FAKE_WISE_PORT: String(FAKE_WISE_PORT) },
        },
        {
          command: 'node apps/api/dist/server.js',
          url: `${liveBaseURL}/readyz`,
          reuseExistingServer: !process.env['CI'],
          timeout: 60_000,
          env: appEnv(LIVE_PORT, {
            MONOBANK_API_URL: `http://127.0.0.1:${FAKE_PORT}`,
            MONOBANK_MIN_INTERVAL_SECONDS: '4',
            MONOBANK_HISTORY_MONTHS: '2',
            PRIVATBANK_API_URL: `http://127.0.0.1:${FAKE_PRIVAT_PORT}`,
            PRIVATBANK_MIN_INTERVAL_MS: '1100',
            PRIVATBANK_HISTORY_MONTHS: '2',
            WISE_API_URL: `http://127.0.0.1:${FAKE_WISE_PORT}/2026Q4`,
          }),
        },
      ],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: [
        '**/*.mobile.spec.ts',
        '**/monobank.spec.ts',
        '**/privat.spec.ts',
        '**/wise.spec.ts',
      ],
    },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: '**/*.mobile.spec.ts' },
    {
      name: 'monobank',
      use: { ...devices['Desktop Chrome'], baseURL: liveBaseURL },
      testMatch: '**/monobank.spec.ts',
    },
    {
      // Uses the same fake monobank as the project above, whose bucket is shared by every session: after it, never beside it.
      name: 'privat',
      use: { ...devices['Desktop Chrome'], baseURL: liveBaseURL },
      testMatch: '**/privat.spec.ts',
      dependencies: ['monobank'],
    },
    {
      // Beside PrivatBank in one test, so after the project that shares that fake's single limit.
      name: 'wise',
      use: { ...devices['Desktop Chrome'], baseURL: liveBaseURL },
      testMatch: '**/wise.spec.ts',
      dependencies: ['privat'],
    },
  ],
});
