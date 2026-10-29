import { expect, test, type Page } from '@playwright/test';

// The built app is served under a strict Content-Security-Policy (no inline scripts, no eval, same-origin only). The pages
// that pull in the most third-party code (Material overlays, the chart library, the form controls) are where a violation would
// show up, so this walks them with the browser reporting every violation it sees.

async function watchViolations(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = seen;
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push(
        `${event.violatedDirective}: ${event.blockedURI || 'inline'} (${event.sourceFile ?? 'page'})`,
      );
    });
  });
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy|Refused to/i.test(message.text())) {
      consoleErrors.push(message.text());
    }
  });
  return async () => [
    ...(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])),
    ...consoleErrors,
  ];
}

test.describe('content security policy', () => {
  test('every route, the chart, the menus and the Inspector run without a single violation', async ({
    page,
  }) => {
    const violations = await watchViolations(page);

    for (const path of [
      '/dashboard',
      '/transactions',
      '/insights',
      '/payments',
      '/payments/new',
      '/connections',
      '/connect',
    ]) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    }

    // The chart, in both views, with the pointer over it.
    await page.goto('/insights');
    const chart = page.getByTestId('monthly-chart');
    await expect(chart.locator('.apexcharts-bar-area').first()).toBeVisible();
    await chart.locator('.apexcharts-bar-area').nth(3).hover();
    await expect(chart.locator('.apexcharts-tooltip.apexcharts-active')).toBeVisible();
    await page.getByTestId('chart-view').getByRole('radio', { name: 'Table' }).click();

    // Overlays: the category menu, the bank picker, the Inspector, a dialog.
    await page.goto('/transactions');
    await page.getByTestId('change-category').first().click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.goto('/payments/new');
    await page.getByTestId('bank-select').click();
    await expect(page.getByRole('listbox')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByTestId('inspector-toggle').click();
    await expect(page.getByRole('heading', { name: 'API Inspector' })).toBeVisible();
    await page.goto('/connections');
    await page.getByTestId('delete-all').click();
    await expect(page.getByRole('dialog')).toBeVisible();

    expect(await violations()).toEqual([]);
  });

  test('the policy itself: scripts only from this origin, no eval, nothing framed', async ({
    page,
  }) => {
    const response = await page.goto('/dashboard');
    const csp = response?.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/'unsafe-eval'|'unsafe-inline'[^;]*script|script-src[^;]*\*/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(response?.headers()['x-content-type-options']).toBe('nosniff');
    expect(response?.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });
});
