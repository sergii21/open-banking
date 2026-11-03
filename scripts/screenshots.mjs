// Takes the small screenshots in docs/screenshots from a running app. Start the servers first (see the header of
// playwright.config.ts for the environment), then: node scripts/screenshots.mjs
//   DEMO  http://localhost:4300   the built app on the demo bank
//   LIVE  http://localhost:4301   the real-token flows against the paced fake monobank on :4310 (one read per few seconds)
//                                 and the fake PrivatBank Autoclient on :4311 (one request a second)
/* global document */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';

const require = createRequire(new URL('../package.json', import.meta.url).pathname);
const { chromium } = require('@playwright/test');

const DEMO = process.env.DEMO_URL ?? 'http://localhost:4300';
const LIVE = process.env.LIVE_URL ?? 'http://localhost:4301';
const FAKE = process.env.FAKE_URL ?? 'http://127.0.0.1:4310';
const FAKE_PRIVAT = process.env.FAKE_PRIVAT_URL ?? 'http://127.0.0.1:4311';
const TOKEN = 'demo-token-ledger-lens-not-a-real-bank';
const PRIVAT_TOKEN = 'privat-autoclient-fake-token-not-a-real-bank';
// Built from the layout of a Privat24 export as it was described: UNVERIFIED against a real one.
const STATEMENT = new URL('../fixtures/privat24/unverified-statement.csv', import.meta.url)
  .pathname;
const out = new URL('../docs/screenshots/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const shot = async (page, name) => {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((a) => Number.isFinite(a.effect?.getComputedTiming().iterations ?? 1))
        .map((a) => a.finished.catch(() => undefined)),
    ),
  );
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${out}${name}.jpg`, type: 'jpeg', quality: 82 });
  process.stdout.write(`  ${name}\n`);
};
async function context(base, { width, height, scheme = 'dark', scale = 1 }) {
  const ctx = await browser.newContext({
    baseURL: base,
    viewport: { width, height },
    colorScheme: scheme,
    deviceScaleFactor: scale,
    ...(width < 500 ? { isMobile: true, hasTouch: true } : {}),
  });
  return { ctx, page: await ctx.newPage() };
}
async function demo(page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try with demo data' }).click();
  await page.waitForURL(/home/);
  await page.waitForFunction(
    () => {
      const text = document.querySelector('.sync-chip')?.textContent ?? '';
      return text.trim() !== '' && !/Loading|Next step|Connecting|…|\d+ of \d+/.test(text);
    },
    null,
    { timeout: 30000 },
  );
  await page.waitForTimeout(600);
}

const D = { width: 1280, height: 800 };
const P = { width: 375, height: 812, scale: 1 };

process.stdout.write('demo, desktop\n');
{
  const { ctx, page } = await context(DEMO, D);
  await page.goto('/');
  await shot(page, '01-welcome-dark');
  await demo(page);
  await shot(page, '03-home-dark');
  await page.getByRole('link', { name: 'Activity' }).click();
  await page.locator('.row').first().waitFor();
  await shot(page, '05-activity-dark');
  await page.locator('.row').nth(2).click();
  await shot(page, '06-activity-detail');
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Insights' }).click();
  await page.getByRole('heading', { name: 'Where it went' }).waitFor();
  await shot(page, '07-insights-dark');
  await page.getByRole('button', { name: 'Settings' }).click();
  await shot(page, '08-settings');
  await page.getByRole('button', { name: /Live API/ }).click();
  await shot(page, '09-live-api');
  await ctx.close();
}
{
  const { ctx, page } = await context(DEMO, { ...D, scheme: 'light' });
  await demo(page);
  await shot(page, '04-home-light');
  await page.getByRole('link', { name: 'Activity' }).click();
  await page.locator('.row').first().waitFor();
  await shot(page, '05b-activity-light');
  await ctx.close();
}

process.stdout.write('demo, phone\n');
{
  const { ctx, page } = await context(DEMO, P);
  await demo(page);
  await shot(page, '10-home-phone-dark');
  await page.getByRole('link', { name: 'Activity' }).click();
  await page.locator('.row').first().waitFor();
  await shot(page, '11-activity-phone');
  await page.getByRole('link', { name: 'Insights' }).click();
  await page.getByRole('heading', { name: 'Where it went' }).waitFor();
  await shot(page, '12-insights-phone');
  await ctx.close();
}
{
  const { ctx, page } = await context(DEMO, { width: 320, height: 640, scale: 1 }, 'dark');
  await page.goto('/');
  await shot(page, '13-welcome-320');
  await demo(page);
  await shot(page, '14-home-320');
  await ctx.close();
}
{
  const { ctx, page } = await context(DEMO, { width: 375, height: 812, scheme: 'light', scale: 1 });
  await demo(page);
  await shot(page, '10b-home-phone-light');
  await ctx.close();
}

process.stdout.write('real-token flow against the paced fake monobank\n');
{
  const { ctx, page } = await context(LIVE, D);
  await page.goto('/');
  await page.getByLabel('Your monobank token').fill('x'.repeat(44));
  await page.getByRole('button', { name: 'Connect monobank' }).click();
  await page.getByRole('alert').waitFor();
  await shot(page, '02-wrong-token');
  await page.getByLabel('Your monobank token').fill(TOKEN);
  await page.getByRole('button', { name: 'Connect monobank' }).click();
  await page.waitForURL(/home/);
  await page.locator('.hero > .amt').waitFor();
  await page.waitForTimeout(1500);
  await shot(page, '15-paced-home-loading');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Live API/ }).click();
  await shot(page, '16-paced-live-api');
  await page.keyboard.press('Escape');

  // A second person connecting within the limit: monobank says wait, and the screen says so.
  const second = await context(LIVE, D);
  await second.page.goto('/');
  await second.page.getByLabel('Your monobank token').fill(TOKEN);
  await second.page.getByRole('button', { name: 'Connect monobank' }).click();
  await second.page.getByRole('alert').waitFor();
  await shot(second.page, '17-rate-limit');
  await second.ctx.close();

  // The bank goes down while history is loading.
  await fetch(`${FAKE}/__admin/down`);
  await page
    .getByRole('button', { name: 'Close' })
    .first()
    .click()
    .catch(() => undefined);
  await page.getByRole('button', { name: /Needs attention/ }).waitFor({ timeout: 60000 });
  await page.reload();
  await page.locator('.hero > .amt').waitFor();
  await page.waitForTimeout(800);
  await shot(page, '18-bank-down');
  await fetch(`${FAKE}/__admin/up`);
  await ctx.close();
}

process.stdout.write('PrivatBank, two banks, statement files\n');
const idle = (page) =>
  page.waitForFunction(
    () => /Updated/.test(document.querySelector('.sync-chip')?.textContent ?? ''),
    null,
    { timeout: 90000 },
  );
{
  const { ctx, page } = await context(LIVE, D);
  await page.goto('/');
  await page.getByRole('radio', { name: 'PrivatBank' }).click();
  await shot(page, '20-privatbank-pane');
  await page.getByLabel('Your PrivatBank token').fill(PRIVAT_TOKEN);
  await page.getByRole('button', { name: 'Connect PrivatBank' }).click();
  await page.waitForURL(/home/);
  await idle(page);
  await page.waitForTimeout(600);
  await shot(page, '21-privatbank-home');

  // The bank in its daily routine: the screen says so, in words.
  await fetch(`${FAKE_PRIVAT}/__admin/routine`, { method: 'POST' });
  await page.locator('.sync-chip').click();
  await page.getByRole('alert').first().waitFor({ timeout: 20000 });
  await shot(page, '22-privatbank-routine');
  await fetch(`${FAKE_PRIVAT}/__admin/work`, { method: 'POST' });

  // Add monobank beside it (the fake monobank allows one check per few seconds, so let the earlier sections' budget pass).
  await page.waitForTimeout(6000);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Add a bank/ }).click();
  await page.getByRole('radio', { name: 'monobank' }).click();
  await page.getByLabel('Your monobank token').fill(TOKEN);
  await page.getByRole('button', { name: 'Connect monobank' }).click();
  await page.waitForURL(/home/);
  await page.locator('.tile').nth(7).waitFor();
  await page.waitForTimeout(25000);
  await shot(page, '23-two-banks-home');
  await page.getByRole('link', { name: 'Activity' }).click();
  await page.locator('.row').first().waitFor();
  await shot(page, '24-two-banks-activity');
  await page.getByRole('button', { name: 'Settings' }).click();
  await shot(page, '25-two-banks-settings');
  await ctx.close();
}
{
  const { ctx, page } = await context(DEMO, D);
  await page.goto('/');
  await page.getByRole('radio', { name: 'Privat24 file' }).click();
  await shot(page, '26-statement-pane');
  await page.locator('input[type=file]').setInputFiles(STATEMENT);
  await page.waitForURL(/home/);
  await page.locator('.hero > .amt').waitFor();
  await page.waitForTimeout(900);
  await shot(page, '27-statement-home');
  await ctx.close();
}
{
  const { ctx, page } = await context(DEMO, P);
  await page.goto('/');
  await page.getByRole('radio', { name: 'Privat24 file' }).click();
  await page.locator('input[type=file]').setInputFiles(STATEMENT);
  await page.waitForURL(/home/);
  await page.locator('.hero > .amt').waitFor();
  await page.waitForTimeout(900);
  await shot(page, '28-statement-phone');
  await ctx.close();
}

process.stdout.write('server unreachable\n');
{
  const { ctx, page } = await context(DEMO, D);
  await demo(page);
  await page.route('**/api/home', (route) => route.abort());
  await page.getByRole('link', { name: 'Activity' }).click();
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await page.reload();
  await page
    .getByText('Ledger Lens is not reachable')
    .waitFor()
    .catch(() => undefined);
  await shot(page, '19-server-down');
  await ctx.close();
}

await browser.close();
