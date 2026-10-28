import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { accountCard, openInspector, settleAnimations } from './support';

// The token journey for a real bank (monobank), against a local fake of its API. The real service needs a person's own
// token and allows one statement a minute; the app instance under test is configured for a 3 second gap instead.
const FAKE = 'http://127.0.0.1:4310';
const TOKEN_ONE = 'e2e-monobank-token-0001';
const TOKEN_TWO = 'e2e-monobank-token-0002';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectNoViolations(page: Page, scope: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const summary = results.violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help}\n${v.nodes
        .map(
          (n) =>
            `    ${n.target.join(' ')}: ${n.failureSummary?.split('\n').slice(0, 2).join(' ')}`,
        )
        .slice(0, 4)
        .join('\n')}`,
  );
  expect(summary, `${scope} has accessibility violations`).toEqual([]);
}

test.describe.configure({ mode: 'serial' });
test.use({ storageState: { cookies: [], origins: [] } });

test.beforeEach(async ({ request }) => {
  await request.post(`${FAKE}/__reset`);
});

async function connectWithToken(page: Page, token: string): Promise<void> {
  await page.goto('/connect');
  await page.getByTestId('bank-monobank:monobank').click();
  await page.getByTestId('token-input').fill(token);
  await page.getByTestId('connect-with-token').click();
  await expect(page.getByTestId('connect-result')).toContainText('Bank connected');
}

test.describe('monobank (real-bank token journey)', () => {
  test('says it is a real bank, refuses a wrong token, connects with a right one and fills history in the background', async ({
    page,
  }) => {
    await page.goto('/connect');
    await expect(page.getByTestId('mode-badge')).toContainText('Live banks');
    await page.getByTestId('bank-monobank:monobank').click();
    await expect(page.getByRole('heading', { name: 'Connect monobank' })).toBeVisible();
    await expect(page.getByTestId('live-note')).toContainText('This is a real bank');

    // A mistyped token is refused by the bank itself, and the page says so without echoing it.
    await page.getByTestId('token-input').fill('not-a-token-monobank-knows');
    await page.getByTestId('connect-with-token').click();
    await expect(page.getByTestId('token-error')).toContainText('did not accept this token');
    await expect(page.locator('body')).not.toContainText('Something went wrong');
    await settleAnimations(page);
    await expectNoViolations(page, 'the token form with an error');

    await page.getByTestId('token-input').fill(TOKEN_ONE);
    await page.getByTestId('connect-with-token').click();
    await expect(page.getByTestId('connect-result')).toContainText('Bank connected');

    await page.goto('/dashboard');
    await expect(page.getByTestId('account-card')).toHaveCount(4);
    await expect(accountCard(page, 'Platinum card')).toContainText('5,000.00'); // own funds: 25,000 available minus the 30,000 limit
    await expect(accountCard(page, 'На відпустку')).toContainText('45,000.00');
    await expect(page.getByTestId('sync-banner')).toContainText('Loading history from monobank');
    await expect(page.locator('body')).not.toContainText(TOKEN_ONE);

    await expectNoViolations(page, 'the dashboard with the history banner');

    // Four statement reads, three seconds apart; the banner goes away by itself when the last one lands.
    await expect(page.getByTestId('sync-banner')).toBeHidden({ timeout: 45_000 });
    await page.goto('/transactions');
    await expect(page.getByTestId('result-count')).toContainText('3 of 3 transactions');
    await expect(page.getByTestId('txn-title').filter({ hasText: 'Сільпо' })).toBeVisible();
    await expect(page.getByTestId('txn-title').filter({ hasText: 'Зарплата' })).toBeVisible();
    await expect(page.getByTestId('transaction-list')).toContainText('Pending');

    // The Inspector shows the real calls, and the token is not among the things it shows.
    await openInspector(page);
    await page.getByRole('radio', { name: /All calls/ }).click();
    const info = page
      .getByTestId('inspector-calls')
      .getByRole('listitem')
      .filter({ hasText: 'Get client info' })
      .first();
    await info.getByRole('button').click();
    await expect(info.getByTestId('call-detail')).toContainText('x-token: [redacted]');
    await expect(info.getByTestId('call-detail')).not.toContainText(TOKEN_ONE);
    await expect(info.getByTestId('call-detail')).not.toContainText(
      'UA733220010000026201234567890',
    );
  });

  test('a token the bank stops accepting is explained, and pasting a new one fixes it', async ({
    page,
    request,
  }) => {
    await connectWithToken(page, TOKEN_ONE);
    await page.goto('/dashboard');
    await expect(page.getByTestId('account-card')).toHaveCount(4);

    // Let the background load finish, so the call that finds out is the one this test makes.
    await expect(page.getByTestId('sync-banner')).toBeHidden({ timeout: 45_000 });
    await request.post(`${FAKE}/__revoke`);
    const refresh = accountCard(page, 'Black card').first().getByTestId('refresh-account');
    const banner = page.getByTestId('consent-banner');
    // The bank allows one statement read per gap, and the background load just used one: Refresh is told to wait
    // (that is the designed rate-limit state), so press it again until the read goes through and finds the token dead.
    await expect(async () => {
      await expect(refresh).toBeEnabled({ timeout: 1000 });
      await refresh.click();
      await expect(banner).toContainText('monobank no longer accepts your token', {
        timeout: 2500,
      });
    }).toPass({ timeout: 30_000, intervals: [500, 1000, 2000] });
    await page.getByTestId('reconnect').click();
    await expect(page.getByRole('heading', { name: 'Reconnect monobank' })).toBeVisible();

    await page.getByTestId('token-input').fill(TOKEN_TWO);
    await page.getByTestId('connect-with-token').click();
    await expect(page.getByTestId('connect-result')).toContainText('Bank connected');
    await page.goto('/dashboard');
    await expect(page.getByTestId('account-card')).toHaveCount(4); // the same connection, not a second one
    await expect(page.getByTestId('consent-banner')).toHaveCount(0);
  });
});
