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
