import { expect, test } from '@playwright/test';
import { DEMO_TOKEN, watchCsp } from './support';

// The real monobank adapter and the real token flow, against a local fake of monobank's API that enforces the bank's
// one-read-a-minute limit (shortened to four seconds here).
test('pasting a token: a wrong one is explained, the right one shows balances at once and loads history at the bank’s pace', async ({
  page,
}) => {
  const violations = await watchCsp(page);
  await page.goto('/');
  const field = page.getByLabel('Your monobank token');
  const connect = page.getByRole('button', { name: 'Connect monobank' });

  await field.fill('x'.repeat(44));
  await connect.click();
  await expect(page.getByRole('alert')).toContainText(/does not recognise/);

  const started = Date.now();
  await field.fill(DEMO_TOKEN);
  await connect.click();
  await expect(page).toHaveURL(/\/home/);
  await expect(page.locator('.hero > .amt')).toContainText('₴');
  await expect(page.locator('.tile').first()).toBeVisible();
  expect(Date.now() - started).toBeLessThan(5_000); // balances within seconds of pasting

  // History is not instant, and the screen says so instead of pretending.
  const chip = page.locator('.sync-chip');
  await expect(chip).toContainText(/(Loading history|Next step in)/);
  await expect(
    page.getByText(/The 30-day line appears|On pace for|A pace estimate appears/).first(),
  ).toBeVisible();

  // The Live API drawer shows the real calls in the order the pacing allows.
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Live API/ }).click();
  const drawer = page.getByRole('complementary', { name: 'Live API' });
  await expect(drawer.getByText('/personal/client-info').first()).toBeVisible();
  await expect(drawer.getByText('/personal/statement').first()).toBeVisible();
  await drawer.getByText('Get client info').first().click();
  await expect(drawer.locator('pre').first()).toContainText('[redacted]'); // the token never shows

  // A few seconds later the next step has run: more of the history is in.
  await expect
    .poll(async () => (await chip.innerText()).replace(/\s+/g, ' '), { timeout: 40_000 })
    .toMatch(/Updated|Loading history · [2-9]|Next step in .* · [2-9]/);

  // Leaving for good takes two presses, and everything read from the bank is deleted here.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Disconnect and delete my data/ }).click();
  await page.getByRole('button', { name: /Press again to delete everything/ }).click();
  await expect(page).toHaveURL(/\/welcome/);

  expect(await violations()).toEqual([]);
});
