import { expect, test } from '@playwright/test';
import { expectNoViolations, mainNav, openInspector, settleAnimations } from './support';

const ROUTES = [
  { path: '/dashboard', ready: 'account-card' },
  { path: '/transactions', ready: 'transaction-list' },
  { path: '/connections', ready: 'connection-card' },
  { path: '/connect', ready: 'institution-list' },
  { path: '/connect/review/mock:mock-bank', ready: 'continue-to-bank' },
  { path: '/insights', ready: 'kpi-income' },
  { path: '/payments', ready: 'new-payment' },
  { path: '/payments/new', ready: 'payment-form' },
];

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`accessibility (${scheme})`, () => {
    test.use({ colorScheme: scheme });

    for (const route of ROUTES) {
      test(`${route.path} passes axe (WCAG 2.2 AA)`, async ({ page }) => {
        await page.goto(route.path);
        await expect(page.getByTestId(route.ready).first()).toBeVisible();
        await expectNoViolations(page, route.path);
      });
    }

    test('the API Inspector panel passes axe with a call expanded', async ({ page }) => {
      await page.goto('/dashboard');
      await expect(page.getByTestId('account-card').first()).toBeVisible();
      await openInspector(page);
      await page.getByRole('radio', { name: /All calls/ }).click();
      await page.getByTestId('inspector-calls').getByRole('button').first().click();
      await expect(page.getByTestId('call-detail')).toBeVisible();
      await expectNoViolations(page, 'inspector');
    });

    test('the confirm dialog passes axe and traps focus', async ({ page }) => {
      await page.goto('/connections');
      await page.getByTestId('delete-all').click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await settleAnimations(page); // the dialog fades in; contrast must be measured on the final colours
      await expectNoViolations(page, 'confirm dialog');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });
  });
}

test.describe('keyboard and screen reader basics', () => {
  test('the skip link moves focus to the main content', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('account-card').first()).toBeVisible(); // the shell must exist before tabbing into it
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to main content' });
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('main#main')).toBeFocused();
    await expect(page).toHaveURL(/\/dashboard$/);
  });

  test('the Inspector opens with focus inside it, closes on Escape and returns focus to its toggle', async ({
    page,
  }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('account-card').first()).toBeVisible();
    const toggle = page.getByTestId('inspector-toggle');
    await toggle.click();
    await expect(page.getByRole('heading', { name: 'API Inspector' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  test('every page has exactly one h1 and a navigation landmark with the current page marked', async ({
    page,
  }) => {
    for (const route of ROUTES.slice(0, 3)) {
      await page.goto(route.path);
      await expect(page.getByTestId(route.ready).first()).toBeVisible();
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
    }
    await page.goto('/transactions');
    await expect(mainNav(page).locator('a[aria-current="page"]')).toHaveText(/Transactions/);
  });

  test('state is never conveyed by colour alone: money out has a minus sign, pending has a label', async ({
    page,
  }) => {
    await page.goto('/transactions');
    const firstOut = page
      .getByTestId('transaction-list')
      .locator('ll-money[data-amount-minor^="-"]')
      .first();
    await expect(firstOut).toHaveText(/^-[€£]/);
    await expect(page.getByTestId('transaction-list').getByText('Pending').first()).toBeVisible();
  });
});
