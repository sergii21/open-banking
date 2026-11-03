import { test } from '@playwright/test';
import { connectDemo, expectNoViolations, expectNothingPastTheEdge } from './support';

test('phone: every tab fits the screen and passes axe', async ({ page }) => {
  await connectDemo(page);
  await expectNothingPastTheEdge(page);
  await expectNoViolations(page);
  await page.getByRole('link', { name: 'Activity' }).click();
  await page.locator('.row').first().waitFor();
  await expectNothingPastTheEdge(page);
  await page.getByRole('link', { name: 'Insights' }).click();
  await page.getByRole('heading', { name: 'Where it went' }).waitFor();
  await expectNothingPastTheEdge(page);
});

test('the narrowest phones (320 px): nothing sticks out', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  await expectNothingPastTheEdge(page);
  await connectDemo(page);
  await expectNothingPastTheEdge(page);
  for (const name of ['Activity', 'Insights']) {
    await page.getByRole('link', { name }).click();
    await page.waitForTimeout(400);
    await expectNothingPastTheEdge(page);
  }
});
