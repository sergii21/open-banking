import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export const DEMO_TOKEN = 'demo-token-ledger-lens-not-a-real-bank';
export const FAKE_PRIVAT_TOKEN = 'privat-autoclient-fake-token-not-a-real-bank';
/** The fake PrivatBank Autoclient started by playwright.config.ts: its admin switches. */
export const FAKE_WISE_TOKEN = 'wise-fake-personal-token-not-a-real-bank';
/** The fake Wise started by playwright.config.ts: its admin switches. */
export const FAKE_WISE_URL = 'http://127.0.0.1:4312';
export const FAKE_PRIVAT_URL = 'http://127.0.0.1:4311';

/** Starts recording Content-Security-Policy violations; call the returned function at the end to read them. */
export async function watchCsp(page: Page): Promise<() => Promise<string[]>> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = seen;
    document.addEventListener('securitypolicyviolation', (event) => {
      seen.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return () => page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
}

/** From the first-run screen to Home on the demo bank. */
export async function connectDemo(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/welcome/);
  await page.getByRole('button', { name: 'Try with demo data' }).click();
  await expect(page).toHaveURL(/\/home/);
  await expect(page.getByRole('heading', { name: 'Your money' })).toBeVisible();
}

/** Entry animations change opacity; contrast and positions are only meaningful once they are over. */
export async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => document.querySelector('ll-root > *:not(.splash)') !== null);
  await page.waitForTimeout(150);
  await page.waitForFunction(
    () =>
      document
        .getAnimations()
        .filter(
          (a) =>
            Number.isFinite(a.effect?.getComputedTiming().iterations ?? 1) &&
            a.playState !== 'finished',
        ).length === 0,
    undefined,
    { timeout: 10_000 },
  );
}

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

export async function expectNoViolations(page: Page): Promise<void> {
  await settle(page);
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const summary = results.violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help}\n${v.nodes
        .map((n) => `    ${n.target.join(' ')}`)
        .slice(0, 4)
        .join('\n')}`,
  );
  expect(summary, `axe found problems on ${page.url()}:\n${summary.join('\n')}`).toEqual([]);
}

/** Nothing may stick out past the right edge of the screen (a scrollWidth check misses what a clipped container hides). */
export async function expectNothingPastTheEdge(page: Page): Promise<void> {
  await settle(page);
  const offenders = await page.evaluate(() => {
    const edge = document.documentElement.clientWidth;
    return [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          r.width > 0 && r.right > edge + 1 && style.position !== 'fixed' && !el.closest('.chips')
        );
      })
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${el.className}`);
  });
  expect(offenders).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}
