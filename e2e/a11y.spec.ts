import { test } from '@playwright/test';
import { connectDemo, expectNoViolations, settle } from './support';

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`axe, ${scheme}`, () => {
    test.use({ colorScheme: scheme });

    test('the first-run screen', async ({ page }) => {
      await page.goto('/');
      await expectNoViolations(page);
    });

    test('Home, Activity, Insights and the sheets', async ({ page }) => {
      await connectDemo(page);
      await expectNoViolations(page);

      await page.getByRole('link', { name: 'Activity' }).click();
      await page.locator('.row').first().waitFor();
      await expectNoViolations(page);
      await page.locator('.row').first().click();
      await settle(page);
      await expectNoViolations(page);
      await page.keyboard.press('Escape');

      await page.getByRole('link', { name: 'Insights' }).click();
      await page.getByRole('heading', { name: 'Where it went' }).waitFor();
      await expectNoViolations(page);

      await page.getByRole('button', { name: 'Settings' }).click();
      await settle(page);
      await expectNoViolations(page);
    });
  });
}
