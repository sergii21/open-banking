import { expect, test, type Page } from '@playwright/test';
import { EMPTY_STATE, expectNothingPastTheEdge, pay, startPayment } from './support';

// Runs in the `mobile` project (Pixel 7) in a session of its own.
test.use({ storageState: EMPTY_STATE });

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test.describe('payments on a phone', () => {
  test('the form fits the screen and its fields stay reachable', async ({ page }) => {
    await page.goto('/payments/new');
    await expect(page.getByTestId('payment-form')).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await expectNothingPastTheEdge(page, 'payment form');

    const viewport = page.viewportSize();
    for (const id of ['amount', 'reference', 'payee-name', 'iban', 'pay']) {
      const box = await page.getByTestId(id).boundingBox();
      expect(box && viewport && box.x >= 0 && box.x + box.width <= viewport.width, id).toBe(true);
    }
  });

  test('the whole journey works with a touch screen, and the timeline reads top to bottom', async ({
    page,
  }) => {
    await pay(page, { bank: 'Mock Bank UK', amount: '5.00', reference: 'Phone' });
    await expect(page.getByTestId('payment-status')).toContainText('Executed', { timeout: 20_000 });
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await expectNothingPastTheEdge(page, 'payment page');

    const steps = page.getByTestId('timeline').getByRole('listitem');
    await expect(steps).toHaveCount(3);
    const first = await steps.nth(0).boundingBox();
    const last = await steps.nth(2).boundingBox();
    expect(first && last && last.y > first.y && last.x === first.x).toBe(true);
  });

  test('the list and a waiting payment fit too', async ({ page }) => {
    await startPayment(page, { amount: '3.00', reference: 'Waiting' });
    await page.goto('/payments');
    await expect(page.getByTestId('payment-row')).toHaveCount(1);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    await page.getByTestId('payment-row').click();
    await expect(page.getByTestId('resume')).toBeVisible();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
});
