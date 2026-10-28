import { expect, test } from '@playwright/test';
import { connectMockBank, EMPTY_STATE } from './support';

// Every test here starts from a brand-new anonymous session.
test.use({ storageState: EMPTY_STATE });

test.describe('connect a bank', () => {
  test('an empty dashboard invites you to connect, and the journey ends with seeded data', async ({
    page,
  }) => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('dashboard-empty')).toContainText('Connect your first bank');

    await page.getByTestId('connect-first-bank').click();
    await expect(page.getByRole('heading', { name: 'Connect a bank' })).toBeVisible();
    await expect(page.getByTestId('institution-list').getByRole('link')).toHaveCount(3);

    // Search narrows the list.
    await page.getByLabel('Search banks').fill('uk');
    await expect(page.getByTestId('institution-list').getByRole('link')).toHaveCount(1);
    await page.getByLabel('Search banks').fill('');

    await page.getByTestId('bank-mock:mock-bank').click();
    await expect(page.getByRole('heading', { name: 'Connect Mock Bank' })).toBeVisible();
    // What we'll access and for how long, before leaving for the bank.
    await expect(page.getByText('What we’ll see')).toBeVisible();
    await expect(page.getByText('For how long')).toBeVisible();
    await expect(page.getByText('What we won’t do')).toBeVisible();
    await page.getByTestId('continue-to-bank').click();

    // A real full-page redirect to the bank's own page, never an iframe.
    await expect(page).toHaveURL(/\/mock-bank\/auth\//);
    await expect(page.locator('iframe')).toHaveCount(0);
    await expect(page.getByText('This is a simulated bank')).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.getByRole('heading', { name: 'Review access request' })).toBeVisible();
    await expect(page.getByText('cannot move money', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Allow access' }).click();

    await expect(page.getByTestId('connect-result')).toContainText('Bank connected');
    await expect(page.getByText('Accounts found')).toBeVisible();
    await page.getByTestId('go-dashboard').click();

    await expect(page.getByTestId('account-card')).toHaveCount(3);
    const girokonto = page.getByTestId('account-card').filter({ hasText: 'Girokonto' });
    await expect(girokonto.getByTestId('account-balance')).toHaveText('€2,840.13');
    const tagesgeld = page.getByTestId('account-card').filter({ hasText: 'Tagesgeld' });
    await expect(tagesgeld.getByTestId('account-balance')).toHaveText('€8,415.60');
    await expect(page.getByTestId('currency-total')).toContainText('Total in EUR');
    await expect(page.getByTestId('recent-transactions').getByRole('listitem')).toHaveCount(8);
  });

  test('connecting the UK bank adds a separate GBP total instead of mixing currencies', async ({
    page,
  }) => {
    await connectMockBank(page);
    await expect(page.getByTestId('connect-result')).toContainText('Bank connected');
    await connectMockBank(page, { bank: 'mock-bank-uk' });
    await expect(page.getByTestId('connect-result')).toContainText('Bank connected');

    await page.goto('/dashboard');
    await expect(page.getByTestId('currency-total')).toHaveCount(2);
    await expect(
      page.getByTestId('currency-total').filter({ hasText: 'Total in GBP' }),
    ).toBeVisible();
    await expect(
      page
        .getByTestId('account-card')
        .filter({ hasText: 'Everyday Account' })
        .getByTestId('account-balance'),
    ).toHaveText('£1,963.48');
  });

  test('denying consent shows a calm designed state and saves nothing', async ({ page }) => {
    await connectMockBank(page, { decision: 'deny' });
    const result = page.getByTestId('connect-result');
    await expect(result).toContainText('You didn’t give access');
    await expect(result).toContainText('Nothing was shared and nothing was saved');
    await expect(page.getByTestId('try-again')).toBeVisible();

    await page.goto('/connections');
    await expect(page.getByTestId('connections-empty')).toBeVisible();
  });

  test('an SCA timeout at the bank explains what happened and offers to try again', async ({
    page,
  }) => {
    await connectMockBank(page, { persona: 'sca_timeout' });
    await expect(page.getByText('Approve in your banking app')).toBeVisible();
    // The simulated customer never approves; the bank times out after a few seconds and sends us back.
    await expect(page.getByTestId('connect-result')).toContainText(
      'Approval at your bank timed out',
      { timeout: 20_000 },
    );
    await expect(page.getByTestId('try-again')).toBeVisible();
  });

  test('a bank outage during sign-in shows the unavailable state', async ({ page }) => {
    await connectMockBank(page, { persona: 'bank_down' });
    await expect(page.getByRole('heading', { name: /technical difficulties/ })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
    await page.getByRole('link', { name: 'Return to Ledger Lens' }).click();
    await expect(page.getByTestId('connect-result')).toContainText(
      'Your bank isn’t available right now',
    );
  });

  test('the degraded bank warns before you start, and fails the same graceful way', async ({
    page,
  }) => {
    await page.goto('/connect');
    await expect(page.getByTestId('bank-mock:mock-bank-unhealthy')).toContainText(
      'Reporting problems',
    );
    await page.getByTestId('bank-mock:mock-bank-unhealthy').click();
    await expect(page.getByRole('note')).toContainText('reporting problems');
    await page.getByTestId('continue-to-bank').click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: /technical difficulties/ })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
    await page.getByRole('link', { name: 'Return to Ledger Lens' }).click();
    await expect(page.getByTestId('connect-result')).toContainText(
      'Your bank isn’t available right now',
    );
  });

  test('a redirect link that is unknown or already used is rejected safely', async ({ page }) => {
    await page.goto('/api/connections/callback?code=whatever&state=not-a-real-state');
    await expect(page).toHaveURL(/\/connect\/result\?status=invalid_state/);
    await expect(page.getByTestId('connect-result')).toContainText('This link has expired');
  });

  test('refuses a redirect URI the bank has not registered', async ({ request }) => {
    const response = await request.get(
      '/mock-bank/auth/?response_type=code&client_id=ledger-lens-mock&redirect_uri=https%3A%2F%2Fevil.example%2Fsteal&state=abcdefgh&code_challenge=' +
        'x'.repeat(43) +
        '&code_challenge_method=S256&provider=mock-bank',
    );
    expect(response.status()).toBe(400);
    expect(await response.text()).toContain('redirect URI is not registered');
  });
});
