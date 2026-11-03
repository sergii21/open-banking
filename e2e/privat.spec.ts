import { expect, test, type Page } from '@playwright/test';
import {
  DEMO_TOKEN,
  FAKE_PRIVAT_TOKEN,
  FAKE_PRIVAT_URL,
  expectNoViolations,
  expectNothingPastTheEdge,
  settle,
  watchCsp,
} from './support';

// PrivatBank's Autoclient adapter and the multi-bank screens, against a local fake of acp.privatbank.ua that enforces the
// one-request-a-second pace, the page size and the bank's daily routine; and the fake monobank beside it.
test.describe.configure({ mode: 'serial' });

test.afterEach(async ({ request }) => {
  await request.post(`${FAKE_PRIVAT_URL}/__admin/work`);
  await request.post(`${FAKE_PRIVAT_URL}/__admin/up`);
});

async function connectPrivat(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('radio', { name: 'PrivatBank' }).click();
  await page.getByLabel('Your PrivatBank token').fill(FAKE_PRIVAT_TOKEN);
  await page.getByRole('button', { name: 'Connect PrivatBank' }).click();
  await expect(page).toHaveURL(/\/home/);
}

test('PrivatBank key: a wrong one is explained, the right one shows the business accounts at once and loads history at the bank’s pace', async ({
  page,
}) => {
  const violations = await watchCsp(page);
  await page.goto('/');
  await page.getByRole('radio', { name: 'PrivatBank' }).click();
  // The steps name what to restrict the key to, so it can read and never pay.
  await expect(page.getByText('Обмеження по сервісам')).toBeVisible();
  const field = page.getByLabel('Your PrivatBank token');
  const connect = page.getByRole('button', { name: 'Connect PrivatBank' });

  await field.fill('x'.repeat(44));
  await connect.click();
  await expect(page.getByRole('alert')).toContainText(/PrivatBank does not recognise this token/);

  const started = Date.now();
  await field.fill(FAKE_PRIVAT_TOKEN);
  await connect.click();
  await expect(page).toHaveURL(/\/home/);
  await expect(page.locator('.hero > .amt')).toContainText('₴');
  await expect(page.locator('.tile')).toHaveCount(2);
  await expect(page.locator('.tile').first()).toContainText('Business account');
  expect(Date.now() - started).toBeLessThan(8_000); // settings + balances: two requests a second apart

  // History arrives at a request a second, and the screen says so while it does.
  const chip = page.locator('.sync-chip');
  await expect(chip).toContainText(/Loading history|Next step in|Updated/);
  await expect(chip).toContainText(/Updated/, { timeout: 60_000 });
  await expect(page.locator('.hero ll-sparkline svg')).toBeVisible({ timeout: 30_000 }); // the 30-day line, rebuilt from the balance and the items

  // The Live API drawer shows the real calls, with the key, the IBAN and the tax ids hidden.
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Live API/ }).click();
  const drawer = page.getByRole('complementary', { name: 'Live API' });
  await expect(drawer.getByText('/api/statements/settings').first()).toBeVisible();
  await expect(drawer.getByText('/api/statements/transactions').first()).toBeVisible();
  const text = await drawer.innerText();
  expect(text).not.toContain(FAKE_PRIVAT_TOKEN);
  expect(text).not.toContain('UA213052990000026007233566001');
  await drawer.getByText('List balances').first().click();
  const body = await drawer.locator('pre').first().innerText();
  expect(body).toContain('[redacted]'); // the token header
  expect(body).not.toContain('UA2130529900');
  expect(body).not.toContain('26007233566001');
  expect(body).not.toContain('3145128800');
  await page.keyboard.press('Escape');

  expect(await violations()).toEqual([]);
});

test('PrivatBank in its daily routine: the screens say so in words, keep the data, and recover', async ({
  page,
  request,
}) => {
  // The bank is tried again 30 seconds after a failed read, so recovering takes a little over that.
  test.setTimeout(120_000);
  await connectPrivat(page);
  await expect(page.locator('.sync-chip')).toContainText(/Updated/, { timeout: 60_000 });
  const before = await page.locator('.tile').count();

  await request.post(`${FAKE_PRIVAT_URL}/__admin/routine`);
  await page.getByRole('link', { name: 'Activity' }).click();
  await page.locator('.row').first().waitFor();
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await page.locator('.sync-chip').click();
  await expect(page.getByRole('alert').first()).toContainText(
    /PrivatBank is doing its daily routine/,
    {
      timeout: 20_000,
    },
  );
  await expect(page.locator('.tile')).toHaveCount(before);

  await request.post(`${FAKE_PRIVAT_URL}/__admin/work`);
  await expect(page.getByRole('alert')).toHaveCount(0, { timeout: 80_000 });
});

test('two banks at once: one number, accounts and transactions that say where they are, and each bank leaves on its own', async ({
  page,
}) => {
  const violations = await watchCsp(page);
  await connectPrivat(page);
  await expect(page.locator('.sync-chip')).toContainText(/Updated/, { timeout: 60_000 });

  // Add monobank from Settings.
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Add a bank/ }).click();
  await expect(page).toHaveURL(/\/connect/);
  await expect(page.getByRole('heading', { name: 'Add a bank' })).toBeVisible();
  await page.getByRole('radio', { name: 'monobank' }).click();
  await page.getByLabel('Your monobank token').fill(DEMO_TOKEN);
  await page.getByRole('button', { name: 'Connect monobank' }).click();
  await expect(page).toHaveURL(/\/home/);

  // One total over both banks, tiles from both, each naming its bank.
  await expect(page.locator('.hero > .amt')).toContainText('₴');
  await expect(page.locator('.hero-sub')).toContainText(/accounts at 2 banks/);
  await expect(page.locator('.tile')).toHaveCount(8);
  await expect(page.locator('.tile', { hasText: 'PrivatBank · •••• 6001' })).toHaveCount(1);
  await expect(page.locator('.tile', { hasText: 'monobank · •••• ' }).first()).toBeVisible();
  await settle(page);
  await expectNoViolations(page);

  // Activity searches across both, and a chip filters to one bank's account.
  await page.getByRole('link', { name: 'Activity' }).click();
  await page.locator('.row').first().waitFor();
  const chips = page.locator('.chips');
  await expect(
    chips.getByRole('button', { name: /PrivatBank · Business account ••6001/ }),
  ).toBeVisible();
  await expect(chips.getByRole('button', { name: /^monobank · / }).first()).toBeVisible();
  await chips.getByRole('button', { name: /PrivatBank · Business account ••6001/ }).click();
  await expect(page.locator('.row').first()).toContainText('PrivatBank');
  const search = page.getByRole('searchbox', { name: 'Search transactions' });
  await search.fill('Оренда офісу');
  // The search reads the purpose of the payment; the row names who it was paid to.
  await expect(page.locator('.row').first()).toContainText('Коваленко');
  await settle(page);
  await expectNoViolations(page);

  // Settings lists both, each with its own controls; removing PrivatBank leaves monobank and everything read from it.
  await page.getByRole('button', { name: 'Settings' }).click();
  const privat = page.getByRole('region', { name: 'PrivatBank business' });
  const mono = page.getByRole('region', { name: 'monobank' });
  await expect(privat).toBeVisible();
  await expect(mono).toBeVisible();
  await settle(page);
  await expectNoViolations(page);

  // The same screens in dark mode, and all three on a 320 px phone.
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectNoViolations(page);
  await page.setViewportSize({ width: 320, height: 640 });
  await expectNothingPastTheEdge(page);
  await page.keyboard.press('Escape');
  for (const name of ['Home', 'Activity']) {
    await page.getByRole('link', { name, exact: true }).click();
    await page.waitForTimeout(400);
    await expectNothingPastTheEdge(page);
    await expectNoViolations(page);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.getByRole('button', { name: 'Settings' }).click();
  await privat.getByRole('button', { name: /Disconnect and delete my data/ }).click();
  await privat.getByRole('button', { name: /Press again to delete everything/ }).click();
  await expect(page.getByRole('region', { name: 'PrivatBank business' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(page.locator('.tile')).toHaveCount(6);
  await expect(page.locator('.hero-sub')).not.toContainText('banks');

  expect(await violations()).toEqual([]);
});

test('PrivatBank first-run pane and the key form pass axe in this theme, and fit a 320 px phone', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  for (const name of ['monobank', 'PrivatBank', 'Privat24 file']) {
    await page.getByRole('radio', { name }).click();
    await expectNothingPastTheEdge(page);
    await expectNoViolations(page);
  }
});
