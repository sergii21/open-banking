import { expect, test } from '@playwright/test';
import { accountCard, mainNav } from './support';

// Runs in the `mobile` project (Pixel 7) against the shared, connected demo session.
test.describe('phone layout', () => {
  test('the navigation lives in a drawer and nothing scrolls sideways', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('account-card')).toHaveCount(3);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    await page.getByRole('button', { name: 'Open navigation' }).click();
    await mainNav(page).getByRole('link', { name: 'Transactions' }).click();
    await expect(page).toHaveURL(/\/transactions$/);
    await expect(mainNav(page)).toBeHidden(); // drawer closed again
  });

  test('account cards stack in one column and keep their controls reachable', async ({ page }) => {
    await page.goto('/dashboard');
    const girokonto = accountCard(page, 'Girokonto');
    const tagesgeld = accountCard(page, 'Tagesgeld');
    const a = await girokonto.boundingBox();
    const b = await tagesgeld.boundingBox();
    expect(a && b && a.x === b.x && b.y > a.y).toBe(true); // stacked, not side by side
    await expect(girokonto.getByTestId('refresh-account')).toBeVisible();
    const viewport = page.viewportSize();
    const buttonBox = await girokonto.getByTestId('refresh-account').boundingBox();
    expect(buttonBox && viewport && buttonBox.x + buttonBox.width <= viewport.width).toBe(true);
  });

  test('transaction rows stay readable, with the amount visible and aligned', async ({ page }) => {
    await page.goto('/transactions');
    const row = page.getByTestId('transaction-list').getByRole('listitem').first();
    await expect(row.getByTestId('txn-title')).toBeVisible();
    const amount = await row.locator('ll-money').boundingBox();
    const viewport = page.viewportSize();
    expect(amount && viewport && amount.x + amount.width <= viewport.width).toBe(true);

    await page.getByRole('button', { name: /Filters/ }).click();
    await expect(page.getByLabel('Category')).toBeVisible();
  });

  test('the Inspector is a bottom sheet that leaves the page usable', async ({ page }) => {
    await page.goto('/dashboard');
    await page.getByTestId('inspector-toggle').click();
    const panel = page.getByRole('heading', { name: 'API Inspector' });
    await expect(panel).toBeVisible();
    const box = await page.locator('aside#inspector').boundingBox();
    const viewport = page.viewportSize();
    expect(box && viewport && box.y > viewport.height * 0.3 && box.width === viewport.width).toBe(
      true,
    );
    await page.getByRole('button', { name: 'Close API Inspector' }).last().click();
    await expect(page.getByTestId('inspector-toggle')).toHaveAttribute('aria-expanded', 'false');
  });
});
