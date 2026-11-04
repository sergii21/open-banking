import { expect, test, type Page } from '@playwright/test';
import {
  FAKE_PRIVAT_TOKEN,
  FAKE_WISE_TOKEN,
  FAKE_WISE_URL,
  expectNoViolations,
  expectNothingPastTheEdge,
  settle,
  watchCsp,
} from './support';

// Wise as a balances-only bank, against a local fake of api.wise.com (docs.wise.com, version 2026Q4).
test.describe.configure({ mode: 'serial' });

test.afterEach(async ({ request }) => {
  await request.post(`${FAKE_WISE_URL}/__admin/ok`);
});

async function connectWise(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('radio', { name: 'Wise' }).click();
  await page.getByLabel('Your Wise token').fill(FAKE_WISE_TOKEN);
  await page.getByRole('button', { name: 'Connect Wise' }).click();
  await expect(page).toHaveURL(/\/home/);
}

test('Wise: the pane says what it reads and what it does not, a wrong token is explained, the right one shows balances at once', async ({
  page,
}) => {
  const violations = await watchCsp(page);
  await page.goto('/');
  await page.getByRole('radio', { name: 'Wise' }).click();
  await expect(page.getByText('narrowest permission')).toBeVisible();
  await expect(page.getByText(/does not read transactions/)).toBeVisible();
  const field = page.getByLabel('Your Wise token');
  const connect = page.getByRole('button', { name: 'Connect Wise' });

  await field.fill('x'.repeat(40));
  await connect.click();
  await expect(page.getByRole('alert')).toContainText(/Wise does not recognise this token/);

  await field.fill(FAKE_WISE_TOKEN);
  await connect.click();
  await expect(page).toHaveURL(/\/home/);
  await expect(page.locator('.hero > .amt')).toContainText('₴');
  await expect(page.locator('.tile')).toHaveCount(4);
  await expect(page.locator('.tile').first()).toContainText('EUR balance');
  await expect(page.locator('.tile').first()).toContainText('Balance only');
  await expect(page.locator('.tile', { hasText: 'Holiday' })).toContainText('Jar');
  // Nothing to wait for: the loader reads as finished, and the notice about spending is there.
  await expect(page.locator('.sync-chip')).toContainText(/Updated/);
  await expect(page.getByText(/Wise balances count in Your money/)).toBeVisible();

  // The drawer: GETs to the two read paths, the token, profile number and the person's details hidden.
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByText(/Transaction history is not read/)).toBeVisible();
  await page.getByRole('button', { name: /Live API/ }).click();
  const drawer = page.getByRole('complementary', { name: 'Live API' });
  await expect(drawer.getByText('/2026Q4/profiles').first()).toBeVisible();
  const text = await drawer.innerText();
  expect(text).not.toContain(FAKE_WISE_TOKEN);
  expect(text).not.toContain('14575282');
  expect(text).not.toMatch(/statement|transfer/i);
  await drawer.getByText('List profiles').first().click();
  const body = await drawer.locator('pre').first().innerText();
  expect(body).toContain('[redacted]');
  expect(body).not.toContain('made.up@example.com');
  expect(body).not.toContain('1990-01-01');
  await page.keyboard.press('Escape');
  expect(await violations()).toEqual([]);
});

test('Wise asking for strong authentication is explained in words, and the balances already read stay', async ({
  page,
  request,
}) => {
  await connectWise(page);
  await expect(page.locator('.sync-chip')).toContainText(/Updated/, { timeout: 20_000 });
  // The bank is read at most once per interval (1.1 s here): a refresh clicked before the gate opens reads nothing.
  await page.waitForTimeout(1500);
  await request.post(`${FAKE_WISE_URL}/__admin/sca`);
  await page.locator('.sync-chip').click();
  await expect(page.getByRole('alert').first()).toContainText(/strong customer authentication/i, {
    timeout: 20_000,
  });
  await expect(page.locator('.tile')).toHaveCount(4);
});

test('three banks at once: Wise, PrivatBank and a statement file in one number, each leaving on its own', async ({
  page,
}) => {
  await connectWise(page);
  await expect(page.locator('.tile')).toHaveCount(4);

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /^Add a bank/ }).click();
  await page.getByRole('radio', { name: 'PrivatBank' }).click();
  await page.getByLabel('Your PrivatBank token').fill(FAKE_PRIVAT_TOKEN);
  await page.getByRole('button', { name: 'Connect PrivatBank' }).click();
  await expect(page).toHaveURL(/\/home/);
  await expect(page.locator('.tile')).toHaveCount(6);

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Import a Privat24 statement/ }).click();
  await page
    .locator('input[type=file]')
    .setInputFiles('fixtures/privat24/unverified-statement.csv');
  await expect(page).toHaveURL(/\/home/);
  await expect(page.locator('.tile')).toHaveCount(8);
  await expect(page.locator('.hero-sub')).toContainText(/accounts at 2 banks/);
  await expect(page.locator('.tile', { hasText: 'Balance · Wise' }).first()).toBeVisible();
  await settle(page);
  await expectNoViolations(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectNoViolations(page);

  // Settings: a block each; removing Wise leaves the others.
  await page.getByRole('button', { name: 'Settings' }).click();
  const wise = page.getByRole('region', { name: 'Wise' });
  await expect(wise).toContainText('balances only');
  await expectNoViolations(page);
  await wise.getByRole('button', { name: /Disconnect and delete my data/ }).click();
  await wise.getByRole('button', { name: /Press again to delete everything/ }).click();
  await expect(page.getByRole('region', { name: 'Wise' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.tile')).toHaveCount(4);
});

test('Wise pane at 320 px: four choices wrap into rows and nothing sticks out', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  await page.getByRole('radio', { name: 'Wise' }).click();
  await expectNothingPastTheEdge(page);
  await expectNoViolations(page);
  await page.getByLabel('Your Wise token').fill(FAKE_WISE_TOKEN);
  await page.getByRole('button', { name: 'Connect Wise' }).click();
  await expect(page.locator('.tile')).toHaveCount(4);
  await expectNothingPastTheEdge(page);
  await expectNoViolations(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await expectNothingPastTheEdge(page);
});
