import { defineConfig, devices } from '@playwright/test';

const PORT = 4300;

// Set PLAYWRIGHT_BASE_URL to run against a server you started yourself (for example `npm run dev`
// on http://localhost:4200). Otherwise Playwright starts the built app on its own port, backed by an
// in-memory database and the mock bank, so runs are deterministic and never touch your dev data.
const externalBaseUrl = process.env['PLAYWRIGHT_BASE_URL'];
const baseURL = externalBaseUrl ?? `http://localhost:${PORT}`;

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
    : {
        command: 'node apps/api/dist/server.js',
        url: `${baseURL}/readyz`,
        reuseExistingServer: !process.env['CI'],
        timeout: 60_000,
        env: {
          NODE_ENV: 'production',
          HOST: '127.0.0.1',
          PORT: String(PORT),
          PUBLIC_URL: baseURL,
          DATABASE_PATH: ':memory:',
          SESSION_SECRET: 'e2e-only-session-secret-0123456789abcdef',
          TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
          PROVIDERS: 'mock',
          DEMO_CONTROLS: 'true',
          RATE_LIMIT_PER_MINUTE: '100000',
          // Short enough that tests do not wait, long enough to see the button's cool-down state.
          REFRESH_COOLDOWN_SECONDS: '3',
          LOG_LEVEL: 'warn',
        },
      },
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
      testIgnore: ['**/*.mobile.spec.ts', '**/sandbox/**'],
    },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
      dependencies: ['setup'],
      testMatch: '**/*.mobile.spec.ts',
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
