import { defineConfig, devices } from '@playwright/test';

const PORT = 4300;
// A second copy of the app with the real monobank provider pointed at a local fake of monobank's API, which enforces the
// bank's one-read-a-minute limit (shortened to a few seconds so a test can watch the pacing).
const LIVE_PORT = 4301;
const FAKE_PORT = 4310;

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
          command: 'node apps/api/dist/server.js',
          url: `${liveBaseURL}/readyz`,
          reuseExistingServer: !process.env['CI'],
          timeout: 60_000,
          env: appEnv(LIVE_PORT, {
            MONOBANK_API_URL: `http://127.0.0.1:${FAKE_PORT}`,
            MONOBANK_MIN_INTERVAL_SECONDS: '4',
            MONOBANK_HISTORY_MONTHS: '2',
          }),
        },
      ],
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: ['**/*.mobile.spec.ts', '**/monobank.spec.ts'],
    },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: '**/*.mobile.spec.ts' },
    {
      name: 'monobank',
      use: { ...devices['Desktop Chrome'], baseURL: liveBaseURL },
      testMatch: '**/monobank.spec.ts',
    },
  ],
});
