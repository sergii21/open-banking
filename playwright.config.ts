import { defineConfig, devices } from '@playwright/test';

const PORT = 4300;
// A second copy of the app with the monobank provider switched on, pointed at a local fake of the bank's API.
const MONOBANK_PORT = 4301;
const FAKE_MONOBANK_PORT = 4310;

// Set PLAYWRIGHT_BASE_URL to run against a server you started yourself (for example `npm run dev`
// on http://localhost:4200). Otherwise Playwright starts the built app on its own port, backed by an
// in-memory database and the mock bank, so runs are deterministic and never touch your dev data.
const externalBaseUrl = process.env['PLAYWRIGHT_BASE_URL'];
const baseURL = externalBaseUrl ?? `http://localhost:${PORT}`;
const monobankBaseURL = `http://localhost:${MONOBANK_PORT}`;

const appEnv = (port: number, publicUrl: string, extra: Record<string, string> = {}) => ({
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  PORT: String(port),
  PUBLIC_URL: publicUrl,
  DATABASE_PATH: ':memory:',
  SESSION_SECRET: 'e2e-only-session-secret-0123456789abcdef',
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  PROVIDERS: 'mock',
  DEMO_CONTROLS: 'true',
  RATE_LIMIT_PER_MINUTE: '100000',
  // Short enough that tests do not wait, long enough to see the button's cool-down state.
  REFRESH_COOLDOWN_SECONDS: '3',
  LOG_LEVEL: 'warn',
  ...extra,
});

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: process.env['CI'] ? 2 : undefined,
  reporter: process.env['CI']
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'on-first-retry',
    storageState: 'e2e/.auth/user.json',
  },
  webServer: externalBaseUrl
    ? undefined
    : [
        {
          command: 'node apps/api/dist/server.js',
          url: `${baseURL}/readyz`,
          reuseExistingServer: !process.env['CI'],
          timeout: 60_000,
          env: appEnv(PORT, baseURL),
        },
        {
          command: 'node e2e/support/fake-monobank.mjs',
          url: `http://127.0.0.1:${FAKE_MONOBANK_PORT}/health`,
          // Never adopt whatever happens to listen there: another app answering 200 would pass for the fake bank.
          reuseExistingServer: false,
          timeout: 30_000,
          env: { FAKE_MONOBANK_PORT: String(FAKE_MONOBANK_PORT) },
        },
        {
          command: 'node apps/api/dist/server.js',
          url: `${monobankBaseURL}/readyz`,
          reuseExistingServer: !process.env['CI'],
          timeout: 60_000,
          env: appEnv(MONOBANK_PORT, monobankBaseURL, {
            PROVIDERS: 'mock,monobank',
            MONOBANK_API_URL: `http://127.0.0.1:${FAKE_MONOBANK_PORT}`,
            // One month and a 3 s gap keep the background load short but long enough to see the progress banner.
            MONOBANK_HISTORY_MONTHS: '1',
            MONOBANK_MIN_INTERVAL_SECONDS: '3',
          }),
        },
      ],
  projects: [
    {
      name: 'setup',
      testMatch: '**/auth.setup.ts',
      // Starts from a genuinely empty state. `storageState: undefined` reads as "not set" and falls
      // back to the top-level value above, which fails on a clean checkout because that file is what
      // this project creates.
      use: { storageState: { cookies: [], origins: [] } },
    },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
      testIgnore: ['**/*.mobile.spec.ts', '**/sandbox/**', '**/monobank.spec.ts'],
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
      dependencies: ['setup'],
      testMatch: '**/*.mobile.spec.ts',
    },
    {
      // The token-based real-bank journey, against a fake of monobank's API on its own app instance.
      name: 'monobank',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: monobankBaseURL,
        storageState: { cookies: [], origins: [] },
      },
      testMatch: '**/monobank.spec.ts',
    },
    {
      // Opt-in: needs TrueLayer sandbox credentials in apps/api/.env. Run with `npm run e2e:sandbox`.
      name: 'sandbox',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
      testMatch: '**/sandbox/**/*.spec.ts',
    },
  ],
});
