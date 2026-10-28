import { TestBed } from '@angular/core/testing';
import type { Connection } from '@ledger-lens/contracts';
import { SyncBanner } from './sync-banner';

const connection = (overrides: Partial<Connection> = {}): Connection => ({
  id: 'con_1',
  provider: 'monobank',
  mode: 'live',
  institutionId: 'monobank:monobank',
  institutionName: 'monobank',
  institutionLogoUrl: null,
  status: 'active',
  permissions: ['accounts', 'balances', 'transactions'],
  createdAt: '2026-10-28T10:00:00.000Z',
  consentExpiresAt: null,
  consentState: 'none',
  consentDaysRemaining: null,
  lastRefreshedAt: null,
  accountCount: 4,
  sync: null,
  ...overrides,
});

async function render(connections: Connection[]): Promise<HTMLElement> {
  const fixture = TestBed.createComponent(SyncBanner);
  fixture.componentRef.setInput('connections', connections);
  await fixture.whenStable();
  return fixture.nativeElement as HTMLElement;
}

describe('SyncBanner', () => {
  it('says nothing when every connection has finished loading', async () => {
    expect((await render([connection()])).querySelector('[data-testid="sync-banner"]')).toBeNull();
  });

  it('explains the wait and exposes real progress to assistive technology', async () => {
    const el = await render([connection({ sync: { done: 3, total: 12 } })]);
    const banner = el.querySelector('[data-testid="sync-banner"]');
    expect(banner?.getAttribute('role')).toBe('status');
    expect(banner?.textContent).toContain('Loading history from monobank');
    expect(banner?.textContent).toContain('3 of 12 steps done');
    const bar = el.querySelector('[role="progressbar"]');
    expect(bar?.getAttribute('aria-valuenow')).toBe('3');
    expect(bar?.getAttribute('aria-valuemax')).toBe('12');
    expect(bar?.getAttribute('aria-label')).toBe('History loaded from monobank');
    expect(bar?.firstElementChild?.getAttribute('style')).toContain('25%');
  });

  it('shows one banner per connection that is still loading', async () => {
    const el = await render([
      connection({ id: 'a', sync: { done: 1, total: 4 } }),
      connection({ id: 'b' }),
      connection({ id: 'c', sync: { done: 2, total: 4 } }),
    ]);
    expect(el.querySelectorAll('[data-testid="sync-banner"]')).toHaveLength(2);
  });
});
