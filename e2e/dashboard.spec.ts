import { expect, test } from '@playwright/test';
import { accountCard, openInspector } from './support';

// Read-only checks against the shared, connected demo session from the setup project.
test.describe('dashboard', () => {
  test('shows balances per account and a total per currency from cached data', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(accountCard(page, 'Girokonto').getByTestId('account-balance')).toHaveText(
      '€2,840.13',
    );
    await expect(accountCard(page, 'Tagesgeld').getByTestId('account-balance')).toHaveText(
      '€8,415.60',
    );
    // The card balance depends on how much has been spent since the last statement, but it is money owed.
    await expect(accountCard(page, 'Visa Gold').getByTestId('account-balance')).toContainText('-€');
    await expect(accountCard(page, 'Girokonto').getByTestId('account-identifier')).toContainText(
      /DE•• •••• •••• \d{4}/,
    );
    await expect(page.getByTestId('currency-total')).toHaveCount(1);
    await expect(page.getByTestId('currency-total')).toContainText('3 accounts');
  });

  test('lists recent transactions, including a pending one, and links to the full list', async ({
    page,
  }) => {
    await page.goto('/dashboard');
    const rows = page.getByTestId('recent-transactions').getByRole('listitem');
    await expect(rows).toHaveCount(8);
    await expect(
      page.getByTestId('recent-transactions').getByText('Pending').first(),
    ).toBeVisible();
    await page.getByRole('link', { name: 'View all' }).click();
    await expect(page).toHaveURL(/\/transactions$/);
  });

  test('serving the dashboard makes no bank calls: reading is from cache', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('account-card')).toHaveCount(3);
    await openInspector(page);
    await expect(page.getByTestId('inspector-empty')).toContainText(
      'No provider calls on this screen',
    );
    // The calls from connecting are still there under "All calls".
    await page.getByRole('radio', { name: /All calls/ }).click();
    const calls = page.getByTestId('inspector-calls').getByRole('listitem');
    await expect(calls.first()).toBeVisible();
    expect(await calls.count()).toBeGreaterThanOrEqual(12);
  });

  test('the Inspector shows the real calls made while connecting, with secrets redacted', async ({
    page,
  }) => {
    await page.goto('/dashboard');
    await openInspector(page);
    await page.getByRole('radio', { name: /All calls/ }).click();

    const exchange = page
      .getByTestId('inspector-calls')
      .getByRole('listitem')
      .filter({ hasText: 'Exchange authorisation code' });
    await exchange.getByRole('button').click();
    const detail = exchange.getByTestId('call-detail');
    await expect(detail).toContainText('POST https://auth.mockbank.example/connect/token');
    await expect(detail).toContainText('"client_secret": "[redacted]"');
    await expect(detail).toContainText('"code": "[redacted]"');
    await expect(detail).toContainText('"code_verifier": "[redacted]"');
    await expect(detail).not.toContainText('mbk_');
    await expect(detail).not.toContainText('mock-client-secret');

    const accounts = page
      .getByTestId('inspector-calls')
      .getByRole('listitem')
      .filter({ hasText: 'List accounts' })
      .first();
    await accounts.getByRole('button').click();
    await expect(accounts.getByTestId('call-detail')).toContainText(
      /authorization: Bearer ••••[\w-]{4}/,
    );
    await expect(accounts.getByTestId('call-detail')).toContainText('HTTP 200');
  });
});

test.describe('transactions', () => {
  test('groups transactions by day, shows the count and pages with a cursor', async ({ page }) => {
    await page.goto('/transactions');
    await expect(page.getByTestId('result-count')).toContainText(
      /Showing 50 of \d{3,} transactions/,
    );
    await expect(
      page.getByTestId('transaction-list').getByRole('heading', { level: 2 }).first(),
    ).toHaveText(/Today|Yesterday|\w{3}, \d+ \w+ \d{4}/);

    await page.getByTestId('load-more').click();
    await expect(page.getByTestId('result-count')).toContainText(/Showing 100 of \d+ transactions/);
  });

  test('searches without calling the bank, and clears the filter', async ({ page }) => {
    await page.goto('/transactions');
    await page.getByLabel('Search description or merchant').fill('netflix');
    await expect(page.getByTestId('result-count')).toContainText(
      /Showing 1[23] of 1[23] transactions/,
    );
    const titles = page.getByTestId('txn-title');
    await expect(titles.first()).toHaveText('NETFLIX');
    expect(await titles.count()).toBeGreaterThanOrEqual(12);

    await page.getByTestId('clear-filters').click();
    await expect(page.getByTestId('result-count')).toContainText(/Showing 50 of/);
  });

  test('filters by category, direction and amount, and explains an empty result', async ({
    page,
  }) => {
    await page.goto('/transactions');

    await page.getByLabel('Category').click();
    await page.getByRole('option', { name: 'Income' }).click();
    await expect(page.getByTestId('txn-title').first()).toContainText(
      /GEHALT|ERSTATTUNG|ACME|AMAZON|ZALANDO|IKEA|MEDIAMARKT|REWE|.+/,
    );
    await expect(page.getByTestId('result-count')).toHaveText(/Showing \d+ of \d+ transactions/);

    await page.getByTestId('clear-filters').click();
    await page.getByRole('radio', { name: 'Money in' }).click();
    await page.getByLabel('Min amount').fill('3000');
    await expect(page.getByTestId('txn-title').first()).toContainText('GEHALT');

    await page.getByLabel('Min amount').fill('999999');
    await expect(page.getByTestId('transactions-empty')).toContainText('No transactions match');
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.getByTestId('transaction-list')).toBeVisible();
  });

  test('"Transactions" on an account card filters the list to that account', async ({ page }) => {
    await page.goto('/dashboard');
    await accountCard(page, 'Tagesgeld')
      .getByRole('link', { name: /View transactions/ })
      .click();
    await expect(page).toHaveURL(/\/transactions\?account=/);
    await expect(page.getByLabel('Account')).toContainText('Tagesgeld');
    await expect(page.getByTestId('result-count')).toHaveText(/Showing \d+ of \d+ transactions/);
    // Savings only receives the monthly transfer and quarterly interest.
    await expect(page.getByTestId('txn-title').first()).toContainText(
      /DAUERAUFTRAG|ZINSEN|INTEREST|VON GIROKONTO/i,
    );
  });
});

test.describe('connections & privacy', () => {
  test('shows the consent window, what we can read and what we never see', async ({ page }) => {
    await page.goto('/connections');
    const card = page.getByTestId('connection-card');
    await expect(card).toContainText('Mock Bank');
    await expect(card.getByTestId('connection-status')).toContainText('Active');
    await expect(card.getByTestId('consent-line')).toContainText(
      /Ends on \d+ \w+ \d{4} \((89|90) days left\)/,
    );
    await expect(card).toContainText('Cannot move money');
    await expect(
      page.getByText('Your bank login. You sign in on your bank’s own page'),
    ).toBeVisible();
  });
});
