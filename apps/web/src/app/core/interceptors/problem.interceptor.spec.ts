import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { ApiError } from '../api/api-error';
import { SessionService } from '../session/session';
import { problemInterceptor } from './problem.interceptor';

const sessionInfo = {
  id: 'abc12345',
  createdAt: '2026-10-28T10:00:00.000Z',
  environment: 'test',
  demoControls: true,
  providers: [{ id: 'mock', mode: 'mock', label: 'Mock bank' }],
  limits: { maxPaymentMinor: 500_000, refreshCooldownSeconds: 20 },
};

const problem = (code: string, status: number) => ({
  type: 'https://ledger-lens.dev/problems/x',
  title: 'Title',
  status,
  code,
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('problemInterceptor', () => {
  let http: HttpClient;
  let controller: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([problemInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpClient);
    controller = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    controller.verify();
  });

  it('turns a problem+json failure into an ApiError with the stable code', async () => {
    const result = firstValueFrom(http.get('/api/accounts')).catch((error: unknown) => error);
    controller
      .expectOne('/api/accounts')
      .flush(problem('bank_unavailable', 503), { status: 503, statusText: 'Service Unavailable' });
    const error = await result;
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ code: 'bank_unavailable', status: 503 });
  });

  it('starts a new demo session and retries once when the cookie is gone', async () => {
    const result = firstValueFrom(http.get('/api/accounts'));
    controller
      .expectOne('/api/accounts')
      .flush(problem('session_required', 401), { status: 401, statusText: 'Unauthorized' });

    controller.expectOne('/api/session').flush(sessionInfo);
    await settle();
    controller.expectOne('/api/accounts').flush({ items: [] });

    expect(await result).toEqual({ items: [] });
    expect(TestBed.inject(SessionService).info()?.id).toBe('abc12345');
  });

  it('gives up after one retry instead of looping', async () => {
    const result = firstValueFrom(http.get('/api/accounts')).catch((error: unknown) => error);
    controller
      .expectOne('/api/accounts')
      .flush(problem('session_required', 401), { status: 401, statusText: 'Unauthorized' });
    controller.expectOne('/api/session').flush(sessionInfo);
    await settle();
    controller
      .expectOne('/api/accounts')
      .flush(problem('session_required', 401), { status: 401, statusText: 'Unauthorized' });

    expect(await result).toMatchObject({ code: 'session_required' });
    controller.expectNone('/api/session');
  });

  it('never retries the session bootstrap itself', async () => {
    const result = firstValueFrom(http.get('/api/session')).catch((error: unknown) => error);
    controller
      .expectOne('/api/session')
      .flush(problem('session_required', 401), { status: 401, statusText: 'Unauthorized' });
    expect(await result).toBeInstanceOf(ApiError);
    controller.expectNone('/api/session');
  });
});
