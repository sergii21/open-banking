import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { ApiError } from './core/api/api-error';
import { SessionService } from './core/session/session';

describe('App', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
  });

  it('shows the app (router outlet) when the session started', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('router-outlet')).not.toBeNull();
    expect(host.querySelector('[data-testid="boot-retry"]')).toBeNull();
  });

  it('shows a designed, retryable error instead of a blank page when the API is unreachable', async () => {
    TestBed.inject(SessionService).error.set(
      new ApiError('network', 0, 'Ledger Lens could not be reached.'),
    );
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Can’t reach Ledger Lens');
    expect(host.querySelector('[data-testid="boot-retry"]')).not.toBeNull();
    expect(host.querySelector('router-outlet')).toBeNull();
  });
});
