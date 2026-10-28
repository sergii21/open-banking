import { expect, test } from '@playwright/test';
import {
  accountCard,
  connectAndFinish,
  EMPTY_STATE,
  openInspector,
  runDemoAction,
} from './support';

// Each test connects its own bank in a fresh session, because refreshing and the demo controls change state.
test.use({ storageState: EMPTY_STATE });

test.describe('refresh and failure states', () => {
  test.beforeEach(async ({ page }) => {
    await connectAndFinish(page);
    await page.getByTestId('go-dashboard').click();
    await expect(page.getByTestId('account-card')).toHaveCount(3);
  });

  test('Refresh is the one place the bank is called, and the calls appear in the Inspector', async ({
    page,
  }) => {
    await openInspector(page);
    await expect(page.getByTestId('inspector-empty')).toBeVisible();

    const refresh = accountCard(page, 'Girokonto').getByTestId('refresh-account');
    await expect(refresh).toBeEnabled(); // the cool-down after connecting is a couple of seconds in e2e
    await refresh.click();

    await expect(page.getByText('Girokonto updated')).toBeVisible();
    const calls = page.getByTestId('inspector-calls').getByTestId('call-label');
    await expect(calls.filter({ hasText: 'List transactions' })).toHaveCount(1);
    await expect(calls.filter({ hasText: 'Get balance' })).toHaveCount(1);
    await expect(calls.filter({ hasText: 'Get consent details' })).toHaveCount(1);
    await expect(page.getByTestId('call-status').first()).toContainText('200');
    // Pressing it again straight away is blocked by the cool-down, matching the server's limit.
    await expect(refresh).toBeDisabled();
    await expect(refresh).toHaveAttribute('aria-label', /available in \d+ s/);
  });

  test('a bank outage keeps the data, says so plainly, and recovers on retry', async ({ page }) => {
    await runDemoAction(page, 'bank_unavailable_next');
    await expect(page.getByText(/The next bank call will fail with 503/)).toBeVisible();

    const refresh = accountCard(page, 'Girokonto').getByTestId('refresh-account');
    await expect(refresh).toBeEnabled();
    await refresh.click();
    await expect(page.getByText('Your bank isn’t responding')).toBeVisible();
    await expect(page.getByTestId('call-status').first()).toContainText('503');
    // Nothing was lost: the balance is still the last known one.
    await expect(accountCard(page, 'Girokonto').getByTestId('account-balance')).toHaveText(
      '€2,840.13',
    );

    await expect(refresh).toBeEnabled();
    await refresh.click();
    await expect(page.getByText('Girokonto updated')).toBeVisible();
  });

  test('rate limiting from the bank is explained with its retry hint', async ({ page }) => {
    await runDemoAction(page, 'rate_limit_next');
    const refresh = accountCard(page, 'Girokonto').getByTestId('refresh-account');
    await expect(refresh).toBeEnabled();
    await refresh.click();
    await expect(page.getByText('The bank is limiting requests')).toBeVisible();
    await expect(page.getByText('Try again in 30 seconds')).toBeVisible();
    await expect(page.getByTestId('call-status').first()).toContainText('429');
  });

  test('consent revoked at the bank is detected, explained, and fixed by reconnecting', async ({
    page,
  }) => {
    await runDemoAction(page, 'revoke_at_bank');
    const refresh = accountCard(page, 'Girokonto').getByTestId('refresh-account');
    await expect(refresh).toBeEnabled();
    await refresh.click();

    await expect(page.getByText('Your bank needs you to sign in again')).toBeVisible();
    const banner = page.getByTestId('consent-banner');
    await expect(banner).toContainText('needs you to sign in again');
    await expect(banner).toHaveAttribute('role', 'alert');
    // The cached data stays on screen, but refreshing is off until the person reconnects.
    await expect(accountCard(page, 'Girokonto').getByTestId('account-balance')).toHaveText(
      '€2,840.13',
    );
    await expect(refresh).toBeDisabled();

    // Reconnect through the same journey; the existing connection and its history are kept.
    await page.getByTestId('reconnect').click();
    await expect(page.getByRole('heading', { name: 'Reconnect Mock Bank' })).toBeVisible();
    await page.getByTestId('continue-to-bank').click();
    await page.locator('input[name="persona"][value="anna"]').check();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Allow access' }).click();
    await expect(page.getByTestId('connect-result')).toContainText('Bank connected');

    await page.getByTestId('go-dashboard').click();
    await expect(page.getByTestId('consent-banner')).toHaveCount(0);
    await expect(page.getByTestId('account-card')).toHaveCount(3);
    await page.goto('/connections');
    await expect(page.getByTestId('connection-card')).toHaveCount(1);
  });

  test('an approaching consent end shows a countdown, and an ended one blocks refresh', async ({
    page,
  }) => {
    await runDemoAction(page, 'expire_consent_soon');
    const banner = page.getByTestId('consent-banner');
    await expect(banner).toContainText('Access to Mock Bank ends in 2 days');
    await expect(banner).toHaveAttribute('role', 'status');
    await expect(page.getByTestId('reconnect')).toHaveText(/Renew access/);

    await page.goto('/connections');
    await expect(page.getByTestId('connection-status')).toContainText('Ends in 2 days');

    await page.goto('/dashboard');
    await runDemoAction(page, 'expire_consent_now');
    await expect(page.getByTestId('consent-banner')).toContainText('Access to Mock Bank has ended');
    await expect(accountCard(page, 'Girokonto').getByTestId('refresh-account')).toBeDisabled();
  });

  test('the short-consent customer shows expiry reminders without any demo control', async ({
    page,
  }) => {
    await page.goto('/connections');
    await page.getByTestId('remove-connection').click();
    await page.getByTestId('confirm-yes').click();
    await expect(page.getByTestId('connections-empty')).toBeVisible();

    await connectAndFinish(page, { persona: 'short_consent' });
    await page.getByTestId('go-dashboard').click();
    await expect(page.getByTestId('consent-banner')).toContainText('ends in 2 days');
  });
});

test.describe('privacy controls', () => {
  test('removing a connection withdraws access and deletes its cached data', async ({ page }) => {
    await connectAndFinish(page);
    await page.goto('/connections');
    await page.getByTestId('remove-connection').click();
    // Cancel is focused first so a stray Enter never deletes anything.
    await expect(page.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.getByTestId('confirm-yes').click();
    await expect(page.getByText('Mock Bank removed and its data deleted.')).toBeVisible();
    await expect(page.getByTestId('connections-empty')).toBeVisible();

    await openInspector(page);
    await page.getByRole('radio', { name: /All calls/ }).click();
    await expect(page.getByTestId('call-label').first()).toHaveText('Delete credentials');

    await page.goto('/transactions');
    await expect(page.getByTestId('transactions-empty')).toBeVisible();
  });

  test('"Delete all my data" erases everything and starts a clean session', async ({ page }) => {
    await connectAndFinish(page);
    await page.goto('/connections');
    await page.getByTestId('delete-all').click();
    await page.getByTestId('confirm-yes').click();

    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByTestId('dashboard-empty')).toBeVisible();
    await page.goto('/connections');
    await expect(page.getByTestId('connections-empty')).toBeVisible();
  });
});
