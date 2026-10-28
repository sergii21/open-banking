import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_VERSION } from '../src/version';
import { createTestApp, type TestApp } from './helpers';

let t: TestApp;
afterEach(async () => {
  await t.close();
});

describe('app shell', () => {
  it('reports liveness and readiness without a session', async () => {
    t = await createTestApp();
    const health = await t.app.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });

    const ready = await t.app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ready' });
  });

  it('describes itself on /api/meta', async () => {
    t = await createTestApp();
    const response = await t.app.inject({ method: 'GET', url: '/api/meta' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      name: 'ledger-lens-api',
      version: APP_VERSION,
      environment: 'test',
      providers: ['mock'],
    });
  });

  it('answers unknown API routes with problem+json and a stable code', async () => {
    t = await createTestApp();
    const response = await t.app.inject({ method: 'GET', url: '/api/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toMatchObject({
      status: 404,
      code: 'not_found',
      instance: '/api/nope',
    });
    expect(response.headers['x-request-id']).toBeTruthy();
  });

  it('sets a strict content security policy', async () => {
    t = await createTestApp();
    const response = await t.app.inject({ method: 'GET', url: '/healthz' });
    const csp = String(response.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('static SPA hosting', () => {
  function webDist(): string {
    const dir = mkdtempSync(join(tmpdir(), 'll-web-'));
    writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Ledger Lens</title>');
    writeFileSync(join(dir, 'main-ABCDEFGH.js'), 'console.log(1)');
    return dir;
  }

  it('serves index.html for client-side routes but never for missing assets or API paths', async () => {
    t = await createTestApp({ webDistDir: webDist() });

    const route = await t.app.inject({ method: 'GET', url: '/transactions?account=1' });
    expect(route.statusCode).toBe(200);
    expect(route.headers['content-type']).toContain('text/html');
    expect(route.body).toContain('Ledger Lens');
    expect(route.headers['cache-control']).toBe('no-cache');

    const asset = await t.app.inject({ method: 'GET', url: '/main-ABCDEFGH.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['cache-control']).toContain('immutable');

    const missingAsset = await t.app.inject({ method: 'GET', url: '/chunk-missing.js' });
    expect(missingAsset.statusCode).toBe(404);
    expect(missingAsset.headers['content-type']).toContain('application/problem+json');

    const api = await t.app.inject({ method: 'GET', url: '/api/unknown' });
    expect(api.statusCode).toBe(404);
    expect(api.headers['content-type']).toContain('application/problem+json');
  });
});
