import { expect, test, type Page } from '@playwright/test';
import {
  accountCard,
  connectAndFinish,
  decideAtBank,
  EMPTY_STATE,
  expectNoViolations,
  pay,
  startPayment,
} from './support';

// Payments change state and are listed per session, so every test starts its own.
test.use({ storageState: EMPTY_STATE });

const status = (page: Page) => page.getByTestId('payment-status');
const outcome = (page: Page) => page.getByTestId('payment-outcome');
const step = (page: Page, name: string) => page.getByTestId(`step-${name}`);

test.describe('the outcomes', () => {
  test('a bank that settles: Pending, Authorised, Executed, Settled, updating without a reload', async ({
    page,
  }) => {
    await pay(page);

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Payment to Erika Mustermann');
    await expect(page.getByTestId('payment-amount')).toHaveText('€12.34');
    await expect(page.getByTestId('timeline').getByRole('listitem')).toHaveCount(4);

    // The page is never reloaded: the server pushes each step as the bank's webhook arrives.
    await expect(status(page)).toContainText('Settled', { timeout: 20_000 });
    for (const name of ['pending', 'authorised', 'executed', 'settled']) {
      await expect(step(page, name)).toHaveAttribute('data-state', 'done');
    }
    await expect(outcome(page)).toContainText('Payment complete');
    await expect(page.getByTestId('payee-account')).toHaveText('DE•• •••• •••• 3000');
  });

  test('a bank with no settlement step ends at Executed, and the timeline has no Settled step', async ({
    page,
  }) => {
    await pay(page, { bank: 'Mock Bank UK', amount: '25.00', reference: 'Lunch' });

    await expect(status(page)).toContainText('Executed', { timeout: 20_000 });
    await expect(page.getByTestId('timeline').getByRole('listitem')).toHaveCount(3);
    await expect(step(page, 'settled')).toHaveCount(0);
    await expect(step(page, 'executed')).toHaveAttribute('data-state', 'done');
    await expect(outcome(page)).toContainText('no separate settlement step');
    await expect(page.getByTestId('payment-amount')).toHaveText('£25.00');
  });

  test('failed authentication is explained, and "Start again" brings the details back', async ({
    page,
  }) => {
    await pay(
      page,
      { amount: '40.00', reference: 'Books' },
      { outcome: 'test_authorisation_failed' },
    );

    await expect(status(page)).toContainText('Failed');
    await expect(outcome(page)).toContainText('Approval at your bank didn’t go through');
    await expect(outcome(page)).toContainText('No money moved');
    await expect(step(page, 'authorised')).toHaveAttribute('data-state', 'failed');
    await expect(step(page, 'pending')).toHaveAttribute('data-state', 'done');

    await page.getByTestId('start-again').click();
    await expect(page).toHaveURL(/\/payments\/new\?/);
    await expect(page.getByTestId('amount')).toHaveValue('40.00');
    await expect(page.getByTestId('reference')).toHaveValue('Books');
    await expect(page.getByTestId('bank-select')).toContainText('Mock Bank');
  });

  test('a bank that rejects after approval, and one that has too little money', async ({
    page,
  }) => {
    await pay(page, {}, { outcome: 'test_execution_rejected' });
    await expect(status(page)).toContainText('Failed', { timeout: 20_000 });
    await expect(outcome(page)).toContainText('The bank rejected the payment');
    // Authorised first, then refused: the failure belongs to the Executed step.
    await expect(step(page, 'authorised')).toHaveAttribute('data-state', 'done');
    await expect(step(page, 'executed')).toHaveAttribute('data-state', 'failed');

    // Ben has a tight month: well under 2,000.00.
    await pay(page, { amount: '2000.00', reference: 'Too much' }, { persona: 'ben' });
    await expect(status(page)).toContainText('Failed', { timeout: 20_000 });
    await expect(outcome(page)).toContainText('Not enough money in the account');
  });

  test('cancelling at the bank is its own outcome', async ({ page }) => {
    await pay(page, {}, { decision: 'cancel' });
    await expect(status(page)).toContainText('Cancelled');
    await expect(outcome(page)).toContainText('You cancelled at the bank');
    await expect(outcome(page)).toContainText('Nothing was paid');
  });

  test('a bank whose payment page is down fails cleanly', async ({ page }) => {
    await startPayment(page, { bank: 'Mock Bank (degraded)' });
    await expect(page.getByRole('heading', { name: /technical difficulties/ })).toBeVisible();
    await page.getByRole('link', { name: 'Return to Ledger Lens' }).click();

    await expect(page).toHaveURL(/\/payments\/pay_[^/]+\/result/);
    await expect(status(page)).toContainText('Failed');
    await expect(outcome(page)).toContainText('The bank had a problem');
  });
});

test.describe('picking up where you left off', () => {
  test('a payment you walked away from can be resumed from the list', async ({ page }) => {
    await startPayment(page, { amount: '9.99', reference: 'Coffee' });
    await expect(page).toHaveURL(/\/mock-bank\/pay\?/);

    // Close the bank page without deciding: the payment is still waiting.
    await page.goto('/payments');
    const row = page.getByTestId('payment-row');
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('payment-status')).toContainText('Waiting for approval');
    await row.click();

    await expect(outcome(page)).toContainText('Waiting for your approval');
    await page.getByTestId('resume').click();
    await decideAtBank(page);
    await expect(status(page)).toContainText('Settled', { timeout: 20_000 });

    await page.getByRole('link', { name: 'Payments', exact: true }).first().click();
    await expect(page.getByTestId('payment-row')).toHaveCount(1);
    await expect(page.getByTestId('payment-row').getByTestId('payment-status')).toContainText(
      'Settled',
    );
  });

  test('"Check now" asks the bank and the page answers', async ({ page }) => {
    await startPayment(page);
    await page.goto('/payments');
    await page.getByTestId('payment-row').click();
    await expect(status(page)).toContainText('Waiting for approval');
    await page.getByTestId('check-now').click();
    await expect(page.getByTestId('check-now')).toBeEnabled();
    await expect(status(page)).toContainText('Waiting for approval'); // nothing changed at the bank, and nothing broke
  });

  test('pressing the button twice sends one payment', async ({ page }) => {
    await page.goto('/payments/new');
    await page.getByTestId('amount').fill('1.00');
    await page.getByTestId('reference').fill('Twice');
    await page.getByTestId('payee-name').fill('Erika Mustermann');
    await page.getByTestId('iban').fill('DE89370400440532013000');
    await page.getByTestId('pay').dblclick();
    await expect(page).toHaveURL(/\/mock-bank\/pay\?/);

    await page.goto('/payments');
    await expect(page.getByTestId('payment-row')).toHaveCount(1);
  });
});

test.describe('the form', () => {
  test('says what is wrong before anything reaches the bank', async ({ page }) => {
    await page.goto('/payments/new');
    await expect(page.getByTestId('payment-form')).toBeVisible();
    await page.getByTestId('pay').click();

    await expect(page.getByText('Enter an amount')).toBeVisible();
    await expect(page.getByText('Add a reference')).toBeVisible();
    await expect(page.getByText('Enter the payee name')).toBeVisible();
    await expect(page).toHaveURL(/\/payments\/new$/);

    await page.getByTestId('amount').fill('12.345');
    await expect(page.getByText('Enter an amount such as 12.50')).toBeVisible();
    await page.getByTestId('amount').fill('999999');
    await expect(page.getByText(/at most €5,000\.00 per payment/i).first()).toBeVisible();

    await page.getByTestId('iban').fill('DE00 0000 0000 0000 0000 00');
    await expect(page.getByText('Enter a valid IBAN')).toBeVisible();
    await page.getByTestId('reference').fill('Not allowed: <>');
    await expect(page.getByText('Letters, digits, space . - / only')).toBeVisible();
  });

  test('asks for the right payee details for the currency', async ({ page }) => {
    await page.goto('/payments/new');
    await expect(page.getByTestId('iban')).toBeVisible();
    await expect(page.getByTestId('sort-code')).toHaveCount(0);

    await page.getByTestId('bank-select').click();
    await page.getByRole('option', { name: 'Mock Bank UK' }).click();
    await expect(page.getByTestId('sort-code')).toBeVisible();
    await expect(page.getByTestId('account-number')).toBeVisible();
    await expect(page.getByTestId('iban')).toHaveCount(0);
    await expect(page.getByTestId('payments-note')).toContainText('Faster Payment');
    await expect(
      page.getByTestId('amount').locator('xpath=ancestor::mat-form-field'),
    ).toContainText('GBP');
  });
});

test.describe('payments and the accounts', () => {
  test('an executed payment leaves the mock account, and shows in transactions after a refresh', async ({
    page,
  }) => {
    await connectAndFinish(page);
    await page.getByTestId('go-dashboard').click();
    const giro = accountCard(page, 'Girokonto');
    await expect(giro.getByTestId('account-balance')).toHaveText('€2,840.13');

    await pay(page, { amount: '12.34', reference: 'Gift', payee: 'Erika Mustermann' });
    await expect(status(page)).toContainText('Settled', { timeout: 20_000 });
    await expect(page.getByTestId('accounts-hint')).toBeVisible();
    await page.getByTestId('accounts-hint').getByRole('link').click();

    await expect(giro.getByTestId('account-balance')).toHaveText('€2,840.13'); // cached until refreshed
    const refresh = giro.getByTestId('refresh-account');
    await expect(refresh).toBeEnabled();
    await refresh.click();
    await expect(page.getByText('Girokonto updated')).toBeVisible();
    await expect(giro.getByTestId('account-balance')).toHaveText('€2,827.79');

    await page.goto('/transactions');
    await expect(
      page.getByTestId('transaction-list').getByText(/UEBERWEISUNG AN ERIKA MUSTERMANN GIFT/),
    ).toBeVisible();
  });
});

test.describe('the demo and the Inspector', () => {
  test('a replayed webhook is recognised as a duplicate and changes nothing', async ({ page }) => {
    await pay(page);
    await expect(status(page)).toContainText('Settled', { timeout: 20_000 });

    await page.getByTestId('replay-webhook').click();
    await expect(page.getByText(/recognised it as a duplicate/)).toBeVisible();
    await expect(status(page)).toContainText('Settled');
    await expect(page.getByTestId('timeline').getByRole('listitem')).toHaveCount(4);
  });

  test('the Inspector shows the real calls behind a payment and the webhooks that came in', async ({
    page,
  }) => {
    await pay(page);
    await expect(status(page)).toContainText('Settled', { timeout: 20_000 });

    await page.getByTestId('inspector-toggle').click();
    await page.getByRole('radio', { name: /All calls/ }).click();
    const labels = page.getByTestId('inspector-calls').getByTestId('call-label');
    await expect(labels.filter({ hasText: 'Create payment' })).toHaveCount(1);
    await expect(labels.filter({ hasText: 'Webhook: payment_authorized' })).toHaveCount(1);
    await expect(labels.filter({ hasText: 'Webhook: payment_settled' })).toHaveCount(1);
  });
});

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`accessibility (${scheme})`, () => {
    test.use({ colorScheme: scheme });

    test('the payment form with errors showing', async ({ page }) => {
      await page.goto('/payments/new');
      await page.getByTestId('pay').click();
      await expect(page.getByText('Enter an amount')).toBeVisible();
      await expectNoViolations(page, 'payment form');
    });

    test('a payment in every state: waiting, settled, failed, cancelled', async ({ page }) => {
      await startPayment(page);
      await page.goto('/payments');
      await expectNoViolations(page, 'payment list (one waiting)');
      await page.getByTestId('payment-row').click();
      await expect(outcome(page)).toContainText('Waiting for your approval');
      await expectNoViolations(page, 'payment waiting');

      await pay(page);
      await expect(status(page)).toContainText('Settled', { timeout: 20_000 });
      await expectNoViolations(page, 'payment settled');

      await pay(page, {}, { outcome: 'test_authorisation_failed' });
      await expect(status(page)).toContainText('Failed');
      await expectNoViolations(page, 'payment failed');

      await pay(page, {}, { decision: 'cancel' });
      await expect(status(page)).toContainText('Cancelled');
      await expectNoViolations(page, 'payment cancelled');
    });
  });
}
