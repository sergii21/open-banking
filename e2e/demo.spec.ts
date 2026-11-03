import { expect, test } from '@playwright/test';
import { connectDemo, settle, watchCsp } from './support';

test('the demo: every tab, instant search, a transaction, the live calls, and no policy violations', async ({
  page,
}) => {
  const violations = await watchCsp(page);
  await connectDemo(page);

  // Home: the hero number, the accounts, and the loader finishing.
  await expect(page.locator('.hero > .amt')).toContainText('₴');
  await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();
  await expect(page.locator('.tile')).toHaveCount(6);
  await expect(page.getByRole('button', { name: /^Updated / })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.hero ll-sparkline svg')).toBeVisible(); // the 30-day line is there once history has loaded

  // Activity: a keystroke filters the list.
  await page.getByRole('link', { name: 'Activity' }).click();
  const search = page.getByRole('searchbox', { name: 'Search transactions' });
  await expect(search).toBeVisible();
  await expect(page.locator('.row').first()).toBeVisible();
  const before = await page.locator('.results-note [aria-live]').innerText();
  await search.fill('Сільпо');
  await expect(page.locator('.row').first()).toContainText('Сільпо');
  expect(await page.locator('.results-note [aria-live]').innerText()).not.toBe(before);
  await search.fill('zzzz-no-such-merchant');
  await expect(page.getByRole('heading', { name: 'Nothing matches' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();

  // A transaction opens as a sheet with the details and a way to change its category.
  await page.locator('.row').first().click();
  const sheet = page.getByRole('dialog', { name: 'Transaction' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('Category')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();

  // Insights: categories and regular payments.
  await page.getByRole('link', { name: 'Insights' }).click();
  await expect(page.getByRole('heading', { name: 'Where it went' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Regular payments' })).toBeVisible();
  await expect(page.locator('.regular-list li').first()).toBeVisible();

  // Settings, and the proof that the numbers are real calls.
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Live API/ }).click();
  const drawer = page.getByRole('complementary', { name: 'Live API' });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText('/personal/client-info').first()).toBeVisible();
  await expect(drawer.getByText('/personal/statement').first()).toBeVisible();

  // The drawer takes focus when it opens, Escape closes it, and focus goes back to the control that started it.
  await expect(drawer.getByRole('button', { name: 'Close' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('button', { name: 'Settings' })).toBeFocused();

  await settle(page);
  expect(await violations()).toEqual([]);
});

test('blurring amounts is one click, covers every screen, and is remembered', async ({ page }) => {
  await connectDemo(page);
  const hero = page.locator('.hero > .amt');
  await expect(hero).toHaveCSS('filter', 'none');
  await page.getByRole('switch', { name: 'Hide amounts' }).click();
  await expect(hero).not.toHaveCSS('filter', 'none');
  await page.getByRole('link', { name: 'Activity' }).click();
  await expect(page.locator('.row .amt').first()).not.toHaveCSS('filter', 'none');
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Show amounts' })).toBeVisible();
  await page.getByRole('switch', { name: 'Show amounts' }).click();
  await expect(page.locator('.row .amt').first()).toHaveCSS('filter', 'none');
});

test('leaving the demo is one click and returns to the first-run screen', async ({ page }) => {
  await connectDemo(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Leave the demo and connect monobank/ }).click();
  await expect(page).toHaveURL(/\/welcome/);
  await expect(page.getByRole('button', { name: 'Try with demo data' })).toBeVisible();
});
