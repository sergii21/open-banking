import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

const KEY = Buffer.alloc(32, 7).toString('base64');
const SECRET = 'x'.repeat(40);

describe('loadConfig', () => {
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
