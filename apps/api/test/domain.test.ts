import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { categorise } from '../src/domain/categoriser';
import { consentView, EXPIRING_SOON_DAYS, hasConsentExpired } from '../src/domain/consent';
import { createPkce, safeEqual, TokenVault, VaultError, verifyPkce } from '../src/domain/crypto';
import {
  INSPECTOR_TRUNCATION,
  redactHeaders,
  redactJson,
  redactUrl,
  truncateJson,
} from '../src/domain/redact';

const key = (): Buffer => randomBytes(32);

describe('TokenVault', () => {
  it('round-trips and never repeats a ciphertext', () => {
    const vault = new TokenVault({ id: 'k1', key: key() });
    const a = vault.seal('secret-token', 'con_1');
    const b = vault.seal('secret-token', 'con_1');
    expect(a).not.toBe(b);
    expect(a.startsWith('v1.k1.')).toBe(true);
    expect(vault.open(a, 'con_1')).toBe('secret-token');
    expect(a).not.toContain('secret-token');
  });

  it('fails closed on a different row, on tampering and on a missing key', () => {
    const vault = new TokenVault({ id: 'k1', key: key() });
    const sealed = vault.seal('secret-token', 'con_1');
    expect(() => vault.open(sealed, 'con_2')).toThrow(VaultError);

    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => vault.open(parts.join('.'), 'con_1')).toThrow(VaultError);

    const other = new TokenVault({ id: 'k2', key: key() });
    expect(() => other.open(sealed, 'con_1')).toThrow(/No vault key "k1"/);
    expect(() => vault.open('garbage', 'con_1')).toThrow(/malformed/);
  });

  it('rotates: new data uses the current key while old ciphertexts still open', () => {
    const oldKey = { id: 'k1', key: key() };
    const sealedWithOld = new TokenVault(oldKey).seal('legacy', 'con_1');
    const rotated = new TokenVault({ id: 'k2', key: key() }, [oldKey]);
    expect(rotated.open(sealedWithOld, 'con_1')).toBe('legacy');
    expect(rotated.seal('fresh', 'con_1').startsWith('v1.k2.')).toBe(true);
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => new TokenVault({ id: 'k1', key: Buffer.alloc(16) })).toThrow(VaultError);
  });
});

describe('PKCE and comparisons', () => {
  it('verifies S256 challenges', () => {
    const { verifier, challenge } = createPkce();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifyPkce(verifier, challenge)).toBe(true);
    expect(verifyPkce('x'.repeat(43), challenge)).toBe(false);
  });

  it('compares in constant time and handles length mismatches', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('redaction', () => {
  it('masks secrets anywhere in a payload but keeps harmless fields', () => {
    const redacted = redactJson(
      {
        access_token: 'abc',
        nested: { refresh_token: 'def', client_secret: 's', code: 'c1', keep: 1 },
        list: [{ code_verifier: 'v' }, { name: 'ok' }],
        resource_token: 'r',
        status: 'Succeeded',
      },
      { maskIdentifiers: false },
    );
    expect(redacted).toEqual({
      access_token: '[redacted]',
      nested: {
        refresh_token: '[redacted]',
        client_secret: '[redacted]',
        code: '[redacted]',
        keep: 1,
      },
      list: [{ code_verifier: '[redacted]' }, { name: 'ok' }],
      resource_token: '[redacted]',
      status: 'Succeeded',
    });
  });

  it('masks account identifiers only for live providers', () => {
    const payload = {
      iban: 'DE89370400440532013000',
      sort_code: '040004',
      display_name: 'Girokonto',
    };
    expect(redactJson(payload, { maskIdentifiers: false })).toEqual(payload);
    expect(redactJson(payload, { maskIdentifiers: true })).toEqual({
      iban: '••••••••3000',
      sort_code: '••••',
      display_name: 'Girokonto',
    });
  });

  it('redacts authorization, cookies and signatures in headers', () => {
    expect(
      redactHeaders({
        Authorization: 'Bearer mbk_at_1234567890abcdef',
        Cookie: 'sid=1',
        'Tl-Signature': 'eyJ...',
        'Idempotency-Key': 'abc',
        accept: 'application/json',
      }),
    ).toEqual({
      Authorization: 'Bearer ••••cdef',
      Cookie: '[redacted]',
      'Tl-Signature': '[redacted]',
      'Idempotency-Key': 'abc',
      accept: 'application/json',
    });
  });

  it('masks secret query values in URLs and tolerates relative ones', () => {
    expect(redactUrl('https://auth.example/cb?code=SECRET&state=ok&client_secret=x')).toBe(
      'https://auth.example/cb?code=[redacted]&state=ok&client_secret=[redacted]',
    );
    expect(redactUrl('/relative?code=1')).toBe('/relative?code=1');
  });

  it('truncates long arrays and strings and reports it', () => {
    const { value, truncated } = truncateJson({
      results: Array.from({ length: 10 }, (_, i) => ({ i })),
      text: 'x'.repeat(INSPECTOR_TRUNCATION.maxStringLength + 50),
    });
    expect(truncated).toBe(true);
    const results = (value as { results: unknown[]; text: string }).results;
    expect(results).toHaveLength(INSPECTOR_TRUNCATION.maxArrayItems + 1);
    expect(results.at(-1)).toBe('… 6 more');
    expect(truncateJson({ small: [1, 2] }).truncated).toBe(false);
  });
});

describe('consent view', () => {
  const now = new Date('2026-10-28T10:00:00.000Z');
  const inDays = (days: number): string =>
    new Date(now.getTime() + days * 86_400_000).toISOString();

  it('classifies the consent by days remaining', () => {
    expect(consentView(inDays(90), 'active', now)).toEqual({ state: 'valid', daysRemaining: 90 });
    expect(consentView(inDays(EXPIRING_SOON_DAYS), 'active', now).state).toBe('expiring_soon');
    expect(consentView(inDays(2), 'active', now)).toEqual({
      state: 'expiring_soon',
      daysRemaining: 2,
    });
    expect(consentView(inDays(-1), 'active', now).state).toBe('expired');
    expect(consentView(null, 'active', now)).toEqual({ state: 'none', daysRemaining: null });
    expect(consentView(inDays(30), 'expired', now).state).toBe('expired');
  });

  it('knows when a stored consent end has passed', () => {
    expect(hasConsentExpired(inDays(-0.001), now)).toBe(true);
    expect(hasConsentExpired(inDays(1), now)).toBe(false);
    expect(hasConsentExpired(null, now)).toBe(false);
  });
});

describe('categorise', () => {
  const cat = (description: string, amountMinor: number, counterparty: string | null = null) =>
    categorise({ description, counterparty, amountMinor });

  it.each([
    ['REWE SAGT DANKE. 4721 BERLIN', -2350, 'groceries'],
    ['LIDL SAGT DANKE 1234 BERLIN', -1200, 'groceries'],
    ['TESCO STORES 3141 LONDON', -899, 'groceries'],
    ['CAFE EINSTEIN 4471 BERLIN', -480, 'dining'],
    ['UBER *TRIP HELP.UBER.COM', -1290, 'transport'],
    ['UBER EATS HELP.UBER.COM', -2190, 'dining'],
    ['DB VERTRIEB GMBH BAHN TICKET', -4990, 'transport'],
    ['SHELL TANKSTELLE 1111 BERLIN', -5200, 'transport'],
    ['AMAZON EU SARL LUXEMBOURG', -2999, 'shopping'],
    ['NETFLIX.COM', -1399, 'subscriptions'],
    ['APPLE.COM/BILL ICLOUD', -299, 'subscriptions'],
    ['FITX FITNESSSTUDIO MITGLIEDSBEITRAG', -2990, 'subscriptions'],
    ['MIETE WOHNUNG HAUSVERWALTUNG MEIER', -115000, 'housing'],
    ['COUNCIL TAX LB HACKNEY', -14200, 'housing'],
    ['STADTWERKE STROM ABSCHLAG', -7800, 'bills'],
    ['VODAFONE MOBILFUNK RECHNUNG', -2499, 'bills'],
    ['OCTOPUS ENERGY DD', -6400, 'bills'],
    ['APOTHEKE AM MARKT 9999 BERLIN', -895, 'health'],
    ['CINEMAXX KINO BERLIN', -1450, 'entertainment'],
    ['DLH LUFTHANSA FLUG', -18900, 'travel'],
    ['BOOKING.COM HOTEL AMSTERDAM', -22000, 'travel'],
    ['SOME UNKNOWN SHOP', -1000, 'other'],
  ])('%s -> %s', (description, amount, expected) => {
    expect(cat(description, amount)).toBe(expected);
  });

  it('treats unmatched money in as income and recognises salary', () => {
    expect(cat('GEHALT ACME GMBH LOHN/GEHALT', 345000)).toBe('income');
    expect(cat('SALARY ACME LTD BGC', 285000)).toBe('income');
    expect(cat('Payment from friend', 4000)).toBe('income');
  });

  it('keeps moves between own accounts out of income and spending', () => {
    expect(cat('DAUERAUFTRAG UMBUCHUNG TAGESGELD / SAVINGS TRANSFER', -30000)).toBe('transfers');
    expect(cat('DAUERAUFTRAG VON GIROKONTO / TRANSFER FROM CURRENT', 30000)).toBe('transfers');
    expect(cat('KREDITKARTENABRECHNUNG VISA GOLD', -41200)).toBe('transfers');
    expect(cat('ZAHLUNGSEINGANG DANKE', 41200)).toBe('income'); // no transfer keyword: provider hint does the work
    expect(
      categorise({
        description: 'ZAHLUNGSEINGANG DANKE',
        counterparty: null,
        amountMinor: 41200,
        providerCategory: 'TRANSFER',
      }),
    ).toBe('transfers');
  });

  it('files refunds under the merchant, not under income', () => {
    expect(cat('ERSTATTUNG AMAZON EU SARL LUXEMBOURG', 2500, 'AMAZON')).toBe('shopping');
  });

  it('matches on the counterparty as well as the description and ignores diacritics', () => {
    expect(cat('Kartenzahlung 12.10.', -450, 'Bäckerei Müller')).toBe('other');
    expect(cat('Kartenzahlung', -450, 'Café Roma')).toBe('dining');
  });
});
