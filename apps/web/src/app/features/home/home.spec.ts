import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Home } from './home';

describe('Home', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
  });

  it('shows the API status once /api/meta responds', async () => {
    const fixture = TestBed.createComponent(Home);
    const http = TestBed.inject(HttpTestingController);

    // The resource issues its request from an effect; tick() runs it. whenStable() would wait for the
    // pending request, so flush first.
    TestBed.tick();
    http.expectOne('/api/meta').flush({
      name: 'ledger-lens-api',
      version: '0.1.0',
      environment: 'test',
      providers: ['mock'],
    });
    await fixture.whenStable();

    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelector('h1')?.textContent).toContain('Ledger Lens');
    expect(host.querySelector('[data-testid="api-status"]')?.textContent).toContain(
      'API 0.1.0 is up',
    );
  });
});
