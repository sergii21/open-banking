import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { Connection } from '@ledger-lens/contracts';
import { ConsentBanner } from './consent-banner';

const connection = (overrides: Partial<Connection> = {}): Connection => ({
  id: 'con_1',
  provider: 'mock',
  mode: 'mock',
  institutionId: 'mock:mock-bank',
  institutionName: 'Mock Bank',
  institutionLogoUrl: null,
  status: 'active',
  permissions: ['accounts', 'balances', 'transactions'],
  createdAt: '2026-10-28T10:00:00.000Z',
  consentExpiresAt: '2027-01-26T10:00:00.000Z',
  consentState: 'valid',
  consentDaysRemaining: 90,
  lastRefreshedAt: '2026-10-28T10:00:00.000Z',
  accountCount: 3,
  sync: null,
  ...overrides,
});

async function render(value: Connection): Promise<HTMLElement> {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(ConsentBanner);
  fixture.componentRef.setInput('connection', value);
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

describe('ConsentBanner', () => {
  it('stays out of the way for a healthy connection', async () => {
    expect((await render(connection())).querySelector('[data-testid="consent-banner"]')).toBeNull();
  });

  it('warns politely with a countdown when consent is about to end', async () => {
    const el = await render(connection({ consentState: 'expiring_soon', consentDaysRemaining: 2 }));
    const banner = el.querySelector('[data-testid="consent-banner"]');
    expect(banner?.textContent).toContain('Access to Mock Bank ends in 2 days');
    expect(banner?.getAttribute('role')).toBe('status');
    expect(el.querySelector('[data-testid="reconnect"]')?.textContent).toContain('Renew access');
  });

  it('speaks in the singular for one day left', async () => {
    const el = await render(connection({ consentState: 'expiring_soon', consentDaysRemaining: 1 }));
    expect(el.textContent).toContain('ends in 1 day');
  });

  it.each([
    ['needs_reauth', 'needs you to sign in again'],
    ['revoked', 'was revoked'],
    ['expired', 'has ended'],
    ['error', 'Something went wrong with Mock Bank'],
  ] as const)('interrupts with an alert and a reconnect action for %s', async (status, text) => {
    const el = await render(connection({ status }));
    const banner = el.querySelector('[data-testid="consent-banner"]');
    expect(banner?.textContent).toContain(text);
    expect(banner?.getAttribute('role')).toBe('alert');
    const link = el.querySelector<HTMLAnchorElement>('[data-testid="reconnect"]');
    expect(link?.getAttribute('href')).toBe('/connect/review/mock:mock-bank?reconnect=con_1');
  });
});
