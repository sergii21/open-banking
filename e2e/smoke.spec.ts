import { expect, test } from '@playwright/test';

test.describe('app shell', () => {
  test('serves the SPA and reaches the API through the same origin', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Ledger Lens' })).toBeVisible();
    await expect(page.getByTestId('api-status')).toContainText('providers: mock');
    expect(consoleErrors).toEqual([]);
  });

  test('answers health probes and unknown API routes with problem+json', async ({ request }) => {
    expect((await request.get('/healthz')).ok()).toBe(true);
    expect((await request.get('/readyz')).ok()).toBe(true);

    const missing = await request.get('/api/does-not-exist');
    expect(missing.status()).toBe(404);
    expect(missing.headers()['content-type']).toContain('application/problem+json');
    expect(await missing.json()).toMatchObject({ code: 'not_found' });
  });
});
