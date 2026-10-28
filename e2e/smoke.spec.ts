import { expect, test } from '@playwright/test';
import { mainNav } from './support';

test.describe('app shell', () => {
  test('serves the SPA with the connected bank and no console errors', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await page.goto('/');
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible();
    await expect(page.getByTestId('account-card')).toHaveCount(3);
    await expect(page.getByTestId('mode-badge')).toContainText('Mock bank');
    expect(consoleErrors).toEqual([]);
  });

  test('navigates between the main screens and keeps the page title in sync', async ({ page }) => {
    await page.goto('/dashboard');
    await mainNav(page).getByRole('link', { name: 'Transactions' }).click();
    await expect(page).toHaveURL(/\/transactions$/);
    await expect(page).toHaveTitle('Transactions · Ledger Lens');
    await mainNav(page).getByRole('link', { name: 'Connections' }).click();
    await expect(page).toHaveTitle('Connections & privacy · Ledger Lens');
    await mainNav(page).getByRole('link', { name: 'Dashboard' }).click();
    await expect(page).toHaveTitle('Dashboard · Ledger Lens');
  });

  test('answers health probes and unknown API routes with problem+json', async ({ request }) => {
    expect((await request.get('/healthz')).ok()).toBe(true);
    expect((await request.get('/readyz')).ok()).toBe(true);

    const missing = await request.get('/api/does-not-exist');
    expect(missing.status()).toBe(404);
    expect(missing.headers()['content-type']).toContain('application/problem+json');
    expect(await missing.json()).toMatchObject({ code: 'not_found' });
  });

  test('sets security headers and never exposes provider tokens to the browser', async ({
    page,
    request,
  }) => {
    const response = await request.get('/');
    const csp = response.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(response.headers()['x-content-type-options']).toBe('nosniff');

    await page.goto('/dashboard');
    await expect(page.getByTestId('account-card')).toHaveCount(3);
    const storage = await page.evaluate(
      () => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
    );
    expect(storage).not.toMatch(/mbk_(at|rt)_/);
    const visibleCookies = await page.evaluate(() => document.cookie);
    expect(visibleCookies).not.toContain('ll_sid'); // the session cookie is HttpOnly
    const apiBodies = await Promise.all(
      ['/api/connections', '/api/accounts', '/api/inspector/calls'].map(async (url) =>
        (await request.get(url)).text(),
      ),
    );
    expect(apiBodies.join('')).not.toMatch(/mbk_(at|rt|code)_/);
  });
});
