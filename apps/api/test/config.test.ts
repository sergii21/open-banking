import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

const KEY = Buffer.alloc(32, 7).toString('base64');
const SECRET = 'x'.repeat(40);

describe('loadConfig', () => {
  it('takes the platform’s external URL for PUBLIC_URL when none is given, and PUBLIC_URL still wins', () => {
    const render = { NODE_ENV: 'production', SESSION_SECRET: SECRET, TOKEN_ENCRYPTION_KEY: KEY };
    const onRender = loadConfig({
      ...render,
      RENDER_EXTERNAL_URL: 'https://ledger-lens.onrender.com',
    });
    expect(onRender.publicUrl).toBe('https://ledger-lens.onrender.com');
    expect(onRender.secureCookies).toBe(true);

    const explicit = loadConfig({
      ...render,
      RENDER_EXTERNAL_URL: 'https://ledger-lens.onrender.com',
      PUBLIC_URL: 'https://demo.example.com',
    });
    expect(explicit.publicUrl).toBe('https://demo.example.com');
  });

  it('uses development defaults: SPA proxy origin, demo controls on, derived dev secrets', () => {
    const config = loadConfig({});
    expect(config.env).toBe('development');
    expect(config.publicUrl).toBe('http://localhost:4200');
    expect(config.secureCookies).toBe(false);
    expect(config.demoControls).toBe(true);
    expect(config.tokenEncryptionKey).toHaveLength(32);
    expect(config.providers.mock.enabled).toBe(true);
  });

  it('refuses to start in production without real secrets', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/SESSION_SECRET is required/);
    expect(() => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: SECRET })).toThrow(
      /TOKEN_ENCRYPTION_KEY is required/,
    );
  });

  it('accepts a production configuration and derives secure cookies from an https public URL', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      SESSION_SECRET: SECRET,
      TOKEN_ENCRYPTION_KEY: KEY,
      PUBLIC_URL: 'https://ledger-lens.example.com/',
    });
    expect(config.isProd).toBe(true);
    expect(config.publicUrl).toBe('https://ledger-lens.example.com');
    expect(config.secureCookies).toBe(true);
    expect(config.demoControls).toBe(false);
  });

  it('rejects an encryption key of the wrong length', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'test', TOKEN_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }),
    ).toThrow(ConfigError);
  });

  it('reports every invalid variable at once', () => {
    expect(() => loadConfig({ PORT: 'abc', SESSION_SECRET: 'short' })).toThrow(
      /PORT[\s\S]*SESSION_SECRET/,
    );
  });

  it('defaults the public URL to the API port outside development', () => {
    expect(loadConfig({ NODE_ENV: 'test', PORT: '4300' }).publicUrl).toBe('http://localhost:4300');
  });

  it('only enables the providers that are listed', () => {
    expect(loadConfig({ PROVIDERS: 'truelayer' }).providers.mock.enabled).toBe(false);
  });
});

describe('loadConfig: TrueLayer', () => {
  const credentials = {
    PROVIDERS: 'mock,truelayer',
    TRUELAYER_CLIENT_ID: 'sandbox-app-1234',
    TRUELAYER_CLIENT_SECRET: 'not-a-real-secret',
  };

  const p521 = (curve: 'secp521r1' | 'prime256v1' = 'secp521r1'): string =>
    generateKeyPairSync('ec', {
      namedCurve: curve,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'sec1', format: 'pem' },
    }).privateKey;

  it('stays off, with a warning, when it is listed but has no credentials', () => {
    const config = loadConfig({ PROVIDERS: 'mock,truelayer' });
    expect(config.providers.truelayer).toBeNull();
    expect(config.providerWarnings).toEqual([expect.stringMatching(/TRUELAYER_CLIENT_ID/)]);
  });

  it('stays off when credentials are present but the provider is not listed', () => {
    const config = loadConfig({ ...credentials, PROVIDERS: 'mock' });
    expect(config.providers.truelayer).toBeNull();
    expect(config.providerWarnings).toEqual([]);
  });

  it('reads account information credentials without a signing key', () => {
    const config = loadConfig(credentials);
    expect(config.providers.truelayer).toMatchObject({
      clientId: 'sandbox-app-1234',
      dataProviders: 'uk-cs-mock',
      signing: null,
      beneficiary: { type: 'merchant_account', merchantAccountIds: {} },
    });
  });

  it('loads an inline key (with escaped newlines, as hosting dashboards store it) and the merchant accounts', () => {
    const pem = p521();
    const config = loadConfig({
      ...credentials,
      TRUELAYER_SIGNING_KEY_ID: 'kid-1',
      TRUELAYER_PRIVATE_KEY: pem.trim().replaceAll('\n', '\\n'),
      TRUELAYER_MERCHANT_ACCOUNT_ID_GBP: 'ma-gbp',
    });
    expect(config.providers.truelayer?.signing).toEqual({
      keyId: 'kid-1',
      privateKeyPem: pem.trim(),
    });
    expect(config.providers.truelayer?.beneficiary).toEqual({
      type: 'merchant_account',
      merchantAccountIds: { GBP: 'ma-gbp' },
    });
  });

  it('loads a key file relative to the API folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'll-key-'));
    writeFileSync(join(dir, 'k.pem'), p521());
    const config = loadConfig(
      {
        ...credentials,
        TRUELAYER_SIGNING_KEY_ID: 'kid-1',
        TRUELAYER_PRIVATE_KEY_PATH: 'k.pem',
      },
      { baseDir: dir },
    );
    expect(config.providers.truelayer?.signing?.keyId).toBe('kid-1');
  });

  it('fails fast on a key that is not P-521, is missing, or has no key id', () => {
    expect(() =>
      loadConfig({
        ...credentials,
        TRUELAYER_SIGNING_KEY_ID: 'kid-1',
        TRUELAYER_PRIVATE_KEY: p521('prime256v1'),
      }),
    ).toThrow(/P-521/);
    expect(() =>
      loadConfig({
        ...credentials,
        TRUELAYER_SIGNING_KEY_ID: 'kid-1',
        TRUELAYER_PRIVATE_KEY_PATH: '/nonexistent/key.pem',
      }),
    ).toThrow(/keys:truelayer/);
    expect(() => loadConfig({ ...credentials, TRUELAYER_PRIVATE_KEY: p521() })).toThrow(
      /TRUELAYER_SIGNING_KEY_ID/,
    );
  });
});

describe('loadConfig: monobank', () => {
  it('is off unless listed', () => {
    const config = loadConfig({});
    expect(config.providers.monobank).toBeNull();
    expect(config.providerWarnings).toEqual([]);
  });

  it('switches on for this machine, with three months of history by default', () => {
    expect(loadConfig({ PROVIDERS: 'monobank' }).providers.monobank).toEqual({
      historyMonths: 3,
      apiUrl: 'https://api.monobank.ua',
      minIntervalSeconds: 61,
    });
    expect(
      loadConfig({ PROVIDERS: 'monobank', MONOBANK_HISTORY_MONTHS: '12' }).providers.monobank
        ?.historyMonths,
    ).toBe(12);
  });

  it('refuses to read real accounts on a public deployment, and says why', () => {
    const config = loadConfig({ PROVIDERS: 'monobank', PUBLIC_URL: 'https://demo.example.com' });
    expect(config.providers.monobank).toBeNull();
    expect(config.providerWarnings).toEqual([
      expect.stringMatching(/personal use on your own machine/),
    ]);
  });

  it('can be forced on a public URL only on purpose', () => {
    const config = loadConfig({
      PROVIDERS: 'monobank',
      PUBLIC_URL: 'https://demo.example.com',
      ALLOW_LIVE_PROVIDERS: 'true',
    });
    expect(config.providers.monobank).not.toBeNull();
  });

  it('will not send a token over plain http to anything but this machine', () => {
    expect(() =>
      loadConfig({ PROVIDERS: 'monobank', MONOBANK_API_URL: 'http://api.example.com' }),
    ).toThrow(/https/);
    expect(
      loadConfig({ PROVIDERS: 'monobank', MONOBANK_API_URL: 'http://127.0.0.1:4310/' }).providers
        .monobank?.apiUrl,
    ).toBe('http://127.0.0.1:4310');
  });
});
