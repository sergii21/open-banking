import { expect, test, type Page } from '@playwright/test';
import { connectAndFinish, EMPTY_STATE, expectNoViolations } from './support';

/** The integer minor units a `ll-money` element carries, so assertions compare numbers rather than formatted text. */
const minor = async (locator: ReturnType<Page['locator']>): Promise<number> =>
  Number(await locator.locator('ll-money').first().getAttribute('data-amount-minor'));

test.describe('insights (shared, read-only session)', () => {
  test('shows income, spending and what was left over, with the period above everything', async ({
    page,
  }) => {
    await page.goto('/insights');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Insights');
    await expect(page.getByTestId('kpi-income')).toBeVisible();
    await expect(page.getByTestId('period-range')).toContainText('2026');

    const income = await minor(page.getByTestId('kpi-income'));
    const spending = await minor(page.getByTestId('kpi-spending'));
    const net = await minor(page.getByTestId('kpi-net'));
    expect(income).toBeGreaterThan(0);
    expect(spending).toBeGreaterThan(0);
    expect(net).toBe(income - spending);
    // The sign is in the text as well as the colour.
    await expect(page.getByTestId('kpi-net')).toContainText(net >= 0 ? '+' : '-');
  });

  test('every figure on the page is the same money: categories, months and totals add up', async ({
    page,
  }) => {
    await page.goto('/insights');
    await expect(page.getByTestId('kpi-income')).toBeVisible();
    const spending = await minor(page.getByTestId('kpi-spending'));
    const income = await minor(page.getByTestId('kpi-income'));

    const rows = page.getByTestId('category-row');
    await expect(rows.first()).toBeVisible();
    const categories = await rows.evaluateAll((els) =>
      els.map((el) => Number(el.querySelector('ll-money')?.getAttribute('data-amount-minor'))),
    );
    expect(categories.reduce((sum, value) => sum + value, 0)).toBe(spending);
    // Biggest first.
    expect([...categories].sort((a, b) => b - a)).toEqual(categories);

    await page.getByTestId('chart-view').getByRole('radio', { name: 'Table' }).click();
    const table = page.getByTestId('monthly-table');
    await expect(table).toBeVisible();
    await expect(table.locator('tbody tr')).toHaveCount(6);
    const totals = await table.locator('tbody tr').evaluateAll((trs) =>
      trs.map((tr) => {
        const cells = [...tr.querySelectorAll('td ll-money')].map((el) =>
          Number(el.getAttribute('data-amount-minor')),
        );
        return { in: cells[0] ?? 0, out: cells[1] ?? 0 };
      }),
    );
    expect(totals.reduce((sum, m) => sum + m.in, 0)).toBe(income);
    expect(totals.reduce((sum, m) => sum + m.out, 0)).toBe(spending);
  });

  test('draws the chart, and its readout names both series for the month under the pointer', async ({
    page,
  }) => {
    await page.goto('/insights');
    const chart = page.getByTestId('monthly-chart');
    await expect(chart.locator('.apexcharts-bar-area')).toHaveCount(12); // 6 months x income and spending
    await expect(page.getByTestId('chart-legend')).toContainText('Income');
    await expect(page.getByTestId('chart-legend')).toContainText('Spending');

    await chart.locator('.apexcharts-bar-area').nth(5).hover();
    const tooltip = chart.locator('.apexcharts-tooltip.apexcharts-active');
    await expect(tooltip).toContainText('Income');
    await expect(tooltip).toContainText('Spending');
    await expect(tooltip).toContainText('€');
  });

  test('finds the standing payments in the demo data, with what they cost per month', async ({
    page,
  }) => {
    await page.goto('/insights');
    const list = page.getByTestId('recurring-list');
    await expect(list).toBeVisible();
    await expect(list).toContainText('Miete');
    await expect(list).toContainText('Netflix');
    await expect(list).toContainText('next around');
    await expect(page.getByTestId('insights-EUR')).toContainText('a month goes on these');
  });

  test('a different period re-scopes everything, and explains how the numbers are counted', async ({
    page,
  }) => {
    await page.goto('/insights');
    await expect(page.getByTestId('kpi-income')).toBeVisible();
    const sixMonths = await minor(page.getByTestId('kpi-income'));

    await page.getByTestId('period').getByRole('radio', { name: '3 months' }).click();
    await expect(page.getByTestId('period-range')).toContainText('1 Aug 2026');
    await expect(page.getByTestId('chart-view')).toBeVisible();
    await expect.poll(() => minor(page.getByTestId('kpi-income'))).toBeLessThan(sixMonths);

    await page.getByTestId('period').getByRole('radio', { name: '12 months' }).click();
    await expect(page.getByTestId('period-range')).toContainText('1 Nov 2025');
    await expect.poll(() => minor(page.getByTestId('kpi-income'))).toBeGreaterThan(sixMonths);

    await page.getByTestId('method').getByText('How these numbers are counted').click();
    await expect(page.getByTestId('method')).toContainText('Transfers between accounts');
  });
});

test.describe('your own categories and the spreadsheet', () => {
  test.use({ storageState: EMPTY_STATE });

  test.beforeEach(async ({ page }) => {
    await connectAndFinish(page);
  });

  test('a category you choose sticks, is marked as yours, and moves the insights with it', async ({
    page,
  }) => {
    await page.goto('/insights');
    const before = await page
      .getByTestId('category-row')
      .filter({ has: page.locator('[data-category="health"]') })
      .count();
    const spendingBefore = await minor(page.getByTestId('kpi-spending'));

    await page.goto('/transactions');
    const row = page.locator('ll-transaction-row').filter({ hasText: 'REWE' }).first();
    await expect(row).toBeVisible();
    await row.getByTestId('change-category').click();
    await page.getByTestId('category-health').click();
    await expect(page.getByText('Filed under Health')).toBeVisible();
    await expect(row.getByTestId('txn-category')).toContainText('Health');
    await expect(row.getByTestId('txn-category')).toContainText('chosen by you');

    // Still there after a reload: it is stored, not just shown.
    await page.reload();
    const again = page.locator('ll-transaction-row').filter({ hasText: 'REWE' }).first();
    await expect(again.getByTestId('txn-category')).toContainText('chosen by you');

    await page.goto('/insights');
    await expect(page.locator('[data-category="health"]')).toHaveCount(before === 0 ? 1 : before);
    expect(await minor(page.getByTestId('kpi-spending'))).toBe(spendingBefore); // the same money, filed elsewhere
  });

  test('the category menu names every category and is reachable by keyboard', async ({ page }) => {
    await page.goto('/transactions');
    const first = page.getByTestId('change-category').first();
    await expect(first).toBeVisible();
    await first.focus();
    await page.keyboard.press('Enter');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveCount(13);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByText(/Filed under/)).toBeVisible();
  });

  test('exports what the filters match as a spreadsheet, and nothing more', async ({ page }) => {
    await page.goto('/transactions');
    await expect(page.locator('ll-transaction-row').first()).toBeVisible();

    const all = page.waitForEvent('download');
    await page.getByTestId('export-csv').click();
    const download = await all;
    expect(download.suggestedFilename()).toMatch(
      /^ledger-lens-transactions-\d{4}-\d{2}-\d{2}\.csv$/,
    );
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const full = Buffer.concat(chunks).toString('utf8');
    const lines = full
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split('\r\n');
    expect(lines[0]).toBe('Date,Status,Account,Description,Counterparty,Category,Amount,Currency');
    expect(lines.length).toBeGreaterThan(100);

    await page.getByRole('searchbox', { name: /Search description/ }).fill('netflix');
    await expect(page.locator('ll-transaction-row').first()).toContainText('NETFLIX');
    await expect(page.getByTestId('export-csv')).toHaveAttribute('href', /q=netflix/);
    const filtered = page.waitForEvent('download');
    await page.getByTestId('export-csv').click();
    const part = await (await filtered).createReadStream();
    const bits: Buffer[] = [];
    for await (const chunk of part) bits.push(chunk as Buffer);
    const few = Buffer.concat(bits).toString('utf8').trimEnd().split('\r\n');
    expect(few.length).toBeGreaterThan(1);
    expect(few.length).toBeLessThan(lines.length);
    expect(few.slice(1).every((line) => /netflix/i.test(line))).toBe(true);
  });
});

test.describe('insights without a bank', () => {
  test.use({ storageState: EMPTY_STATE });

  test('says so and offers to connect one', async ({ page }) => {
    await page.goto('/insights');
    await expect(page.getByTestId('insights-empty')).toContainText('No bank connected yet');
    await expect(page.getByRole('link', { name: 'Connect a bank' })).toBeVisible();
  });
});

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`accessibility (${scheme})`, () => {
    test.use({ colorScheme: scheme });

    test('insights: the chart view, the table view, and the empty state', async ({ page }) => {
      await page.goto('/insights');
      await expect(
        page.getByTestId('monthly-chart').locator('.apexcharts-bar-area').first(),
      ).toBeVisible();
      // Let the columns finish growing: contrast is measured on the final colours.
      await page.waitForTimeout(900);
      await expectNoViolations(page, 'insights (chart)');

      await page.getByTestId('chart-view').getByRole('radio', { name: 'Table' }).click();
      await expect(page.getByTestId('monthly-table')).toBeVisible();
      await expectNoViolations(page, 'insights (table)');
    });

    test('the category menu', async ({ page }) => {
      await page.goto('/transactions');
      await page.getByTestId('change-category').first().click();
      await expect(page.getByRole('menu')).toBeVisible();
      await page.waitForTimeout(300);
      await expectNoViolations(page, 'category menu');
    });
  });
}
