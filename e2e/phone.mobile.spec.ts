import { expect, test } from '@playwright/test';
import { accountCard, expectNothingPastTheEdge, mainNav } from './support';

// Runs in the `mobile` project (Pixel 7) against the shared, connected demo session.
test.describe('phone layout', () => {
  test('the navigation lives in a drawer and nothing scrolls sideways', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('account-card')).toHaveCount(3);
    await expectNothingPastTheEdge(page, 'dashboard');

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
    await expect(page.getByLabel('Category', { exact: true })).toBeVisible();
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

  test('insights stack in one column and the chart fits the screen', async ({ page }) => {
    await page.goto('/insights');
    await expect(page.getByTestId('kpi-income')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(page.getByTestId('category-row').first()).toBeVisible();
    await expectNothingPastTheEdge(page, 'insights');

    const viewport = page.viewportSize();
    const income = await page.getByTestId('kpi-income').boundingBox();
    const spending = await page.getByTestId('kpi-spending').boundingBox();
    expect(income && spending && income.x === spending.x && spending.y > income.y).toBe(true);

    const chart = page.getByTestId('monthly-chart').locator('.apexcharts-canvas');
    await expect(chart).toBeVisible();
    const box = await chart.boundingBox();
    expect(box && viewport && box.x >= 0 && box.x + box.width <= viewport.width).toBe(true);

    await page.getByTestId('chart-view').getByRole('radio', { name: 'Table' }).click();
    const table = await page.getByTestId('monthly-table').boundingBox();
    expect(table && viewport && table.x + table.width <= viewport.width + 1).toBe(true);
  });
});

// The Pixel 7 is 412px wide. Layouts that fit there can still push a card past the edge on the smallest phones in use today
// (320px: an iPhone SE, a split-screen window), and the shell clips what overflows, so nothing scrolls to give it away.
test.describe('the smallest phones (320px)', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  for (const [path, ready] of [
    ['/dashboard', 'account-card'],
    ['/transactions', 'transaction-list'],
    ['/insights', 'category-row'],
    ['/connections', 'connection-card'],
    ['/connect', 'institution-list'],
    ['/payments/new', 'payment-form'],
  ] as const) {
    test(`${path} keeps everything on the screen`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByTestId(ready).first()).toBeVisible();
      await expectNothingPastTheEdge(page, path);
    });
  }

  test('the insights table view and the empty payments list too', async ({ page }) => {
    await page.goto('/insights');
    await expect(page.getByTestId('category-row').first()).toBeVisible();
    await page.getByTestId('chart-view').getByRole('radio', { name: 'Table' }).click();
    await expect(page.getByTestId('monthly-table')).toBeVisible();
    await expectNothingPastTheEdge(page, 'insights (table)');

    await page.goto('/payments');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNothingPastTheEdge(page, 'payments');
  });
});
