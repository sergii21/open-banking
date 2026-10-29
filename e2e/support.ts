import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export const EMPTY_STATE = { cookies: [], origins: [] };

export interface ConnectOptions {
  /** Mock institution slug: mock-bank (EUR), mock-bank-uk (GBP), mock-bank-unhealthy. */
  bank?: string;
  /** Mock customer on the bank's sign-in page. */
  persona?: 'anna' | 'ben' | 'short_consent' | 'sca_timeout' | 'bank_down';
  /** What to do on the bank's consent page. */
  decision?: 'allow' | 'deny';
}

/** Drives the real journey through the UI: picker, consent review, the hosted bank pages, and the redirect back. */
export async function connectMockBank(page: Page, options: ConnectOptions = {}): Promise<void> {
  const { bank = 'mock-bank', persona = 'anna', decision = 'allow' } = options;

  await page.goto('/connect');
  await page.getByTestId(`bank-mock:${bank}`).click();
  await page.getByTestId('continue-to-bank').click();

  await expect(page).toHaveURL(/\/mock-bank\/auth\//);
  await page.locator(`input[name="persona"][value="${persona}"]`).check();
  await page.getByRole('button', { name: 'Continue' }).click();

  if (persona === 'bank_down') return; // the bank shows its outage page; the caller decides what to do

  await expect(page.getByRole('heading', { name: 'Review access request' })).toBeVisible();
  await page.getByRole('button', { name: decision === 'allow' ? 'Allow access' : 'Deny' }).click();
}

/** Connect and wait for the success page. */
export async function connectAndFinish(page: Page, options: ConnectOptions = {}): Promise<void> {
  await connectMockBank(page, options);
  await expect(page.getByTestId('connect-result')).toContainText('Bank connected');
}

export async function openInspector(page: Page): Promise<void> {
  const toggle = page.getByTestId('inspector-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(page.getByRole('heading', { name: 'API Inspector' })).toBeVisible();
}

/** Opens the demo controls and runs one action against the connected mock bank. */
export async function runDemoAction(page: Page, action: string): Promise<void> {
  await openInspector(page);
  const toggle = page.getByTestId('demo-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await page.getByTestId(`demo-${action}`).click();
}

export function accountCard(page: Page, name: string) {
  return page.getByTestId('account-card').filter({ hasText: name });
}

/** The main navigation landmark, to tell its links from same-named links elsewhere on the page. */
export function mainNav(page: Page) {
  return page.getByRole('navigation', { name: 'Main' });
}

/** Waits for CSS transitions and animations (dialog fade, panel slide) so contrast checks see final colours. */
export async function settleAnimations(page: Page): Promise<void> {
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
  );
}

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** axe against WCAG 2.2 AA, with the offending elements named so a failure says where to look. */
export async function expectNoViolations(page: Page, scope = 'page'): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const summary = results.violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help}\n${v.nodes
        .map((n) => `    ${n.target.join(' ')}`)
        .slice(0, 4)
        .join('\n')}`,
  );
  expect(summary, `${scope} has accessibility violations`).toEqual([]);
}

export interface PaymentOptions {
  /** The bank's name as the picker shows it. */
  bank?: 'Mock Bank' | 'Mock Bank UK' | 'Mock Bank (degraded)';
  amount?: string;
  reference?: string;
  payee?: string;
  iban?: string;
  sortCode?: string;
  accountNumber?: string;
}

/** Fills in the payment form and presses the button, which sends the browser to the bank's approval page. */
export async function startPayment(page: Page, options: PaymentOptions = {}): Promise<void> {
  const {
    bank = 'Mock Bank',
    amount = '12.34',
    reference = 'Rent',
    payee = 'Erika Mustermann',
    iban = 'DE89 3704 0044 0532 0130 00',
    sortCode = '112233',
    accountNumber = '12345678',
  } = options;

  await page.goto('/payments/new');
  await expect(page.getByTestId('payment-form')).toBeVisible();
  if (bank !== 'Mock Bank') {
    await page.getByTestId('bank-select').click();
    await page.getByRole('option', { name: bank }).click();
  }
  await page.getByTestId('amount').fill(amount);
  await page.getByTestId('reference').fill(reference);
  await page.getByTestId('payee-name').fill(payee);
  if (bank === 'Mock Bank UK') {
    await page.getByTestId('sort-code').fill(sortCode);
    await page.getByTestId('account-number').fill(accountNumber);
  } else {
    await page.getByTestId('iban').fill(iban);
  }
  await page.getByTestId('pay').click();
}

export interface BankDecision {
  persona?: 'anna' | 'ben';
  outcome?: 'test_executed' | 'test_authorisation_failed' | 'test_execution_rejected';
  decision?: 'approve' | 'cancel';
}

/** On the mock bank's approval page: choose who pays and what happens, press the button, and come back to the app. */
export async function decideAtBank(page: Page, options: BankDecision = {}): Promise<void> {
  const { persona = 'anna', outcome = 'test_executed', decision = 'approve' } = options;
  await expect(page).toHaveURL(/\/mock-bank\/pay\?/);
  await page.locator(`input[name="persona"][value="${persona}"]`).check();
  await page.locator(`input[name="outcome"][value="${outcome}"]`).check();
  await page
    .getByRole('button', { name: decision === 'approve' ? 'Approve payment' : 'Cancel' })
    .click();
  await expect(page).toHaveURL(/\/payments\/pay_[^/]+\/result/);
}

/** The full journey up to the payment page. */
export async function pay(page: Page, payment: PaymentOptions = {}, bank: BankDecision = {}) {
  await startPayment(page, payment);
  await decideAtBank(page, bank);
}

/**
 * Fails when anything in the page's main content reaches past the right edge of the screen. `scrollWidth` alone misses this:
 * the shell clips its own overflow, so a card that is too wide just loses its border off-screen. Content inside a region that
 * scrolls on purpose (a wide table) is allowed to be wider than the screen.
 */
export async function expectNothingPastTheEdge(page: Page, scope = 'page'): Promise<void> {
  const offenders = await page.evaluate(() => {
    const limit = window.innerWidth + 1;
    const scrolls = (el: Element): boolean => {
      for (
        let node: Element | null = el.parentElement;
        node && node.tagName !== 'MAIN';
        node = node.parentElement
      ) {
        const overflow = getComputedStyle(node).overflowX;
        if (
          overflow === 'auto' ||
          overflow === 'scroll' ||
          overflow === 'hidden' ||
          overflow === 'clip'
        )
          return true;
      }
      return false;
    };
    return [...document.querySelectorAll('main *')]
      .filter((el) => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.right > limit && !scrolls(el);
      })
      .slice(0, 5)
      .map(
        (el) =>
          `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)} right=${Math.round(el.getBoundingClientRect().right)}`,
      );
  });
  expect(offenders, `${scope}: elements past the right edge`).toEqual([]);
}
