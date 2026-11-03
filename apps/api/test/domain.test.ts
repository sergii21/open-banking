import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { categorise } from '../src/domain/categoriser';
import { safeEqual, TokenVault, VaultError } from '../src/domain/crypto';
import {
  INSPECTOR_TRUNCATION,
  redactHeaders,
  maskUrlSecrets,
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

describe('comparisons', () => {
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
        nested: { refresh_token: 'def', client_secret: 's', code: 'VE014', keep: 1 },
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
        code: 'VE014', // an error code, not a secret
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
    // A hosted payment page keeps its resource token in the fragment.
    expect(
      redactUrl(
        'https://payment.example/payments#payment_id=p1&resource_token=SECRET&return_uri=https%3A%2F%2Fapp.example%2Fback',
      ),
    ).toBe(
      'https://payment.example/payments#payment_id=p1&resource_token=[redacted]&return_uri=https%3A%2F%2Fapp.example%2Fback',
    );
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

describe('categorise (how monobank rows are filed)', () => {
  const cat = (
    description: string,
    amountMinor: number,
    extra: { mcc?: number; comment?: string; counterparty?: string; fop?: boolean } = {},
  ) =>
    categorise({
      description,
      counterparty: extra.counterparty ?? null,
      comment: extra.comment ?? null,
      amountMinor,
      mcc: extra.mcc ?? null,
      fop: extra.fop ?? false,
    });

  it('trusts the merchant category code first', () => {
    expect(cat('Сільпо', -31_240, { mcc: 5411 })).toBe('groceries');
    expect(cat('Aroma Kava', -9_500, { mcc: 5814 })).toBe('dining');
    expect(cat('Uklon', -14_500, { mcc: 4121 })).toBe('transport');
    expect(cat('Netflix', -19_900, { mcc: 4899 })).toBe('subscriptions');
    expect(cat('Київстар', -35_000, { mcc: 4814 })).toBe('bills');
    expect(cat('Аптека Подорожник', -12_000, { mcc: 5912 })).toBe('health');
    expect(cat('Банкомат Приватбанк', -501_500, { mcc: 6011 })).toBe('transfers');
  });

  it('knows Ukrainian merchants without a code, in Cyrillic and Latin', () => {
    expect(cat('АТБ-маркет', -8_800)).toBe('groceries');
    expect(cat('Сільпо №123', -8_800)).toBe('groceries');
    expect(cat('Київська кав’ярня Кава', -8_800)).toBe('dining');
    expect(cat('UKLON', -8_800)).toBe('transport');
    expect(cat('Нова пошта', -9_000)).toBe('shopping');
    expect(cat('Rozetka', -150_000)).toBe('shopping');
  });

  it('keeps money moving between people and between own accounts out of spending and income', () => {
    expect(cat('Кому: Олена К.', -50_000, { mcc: 4829 })).toBe('transfers');
    expect(cat('Від: Іван П.', 80_000, { mcc: 4829 })).toBe('transfers');
    expect(cat('Переказ на банку «На відпустку»', -300_000, { mcc: 4829 })).toBe('transfers');
    expect(cat('Переказ на власну картку', -3_000_000, { mcc: 4829, fop: true })).toBe('transfers');
  });

  it('recognises salary and, on a FOP account, any named payer as income', () => {
    expect(cat('Зарахування заробітної плати', 3_950_000, { mcc: 4829 })).toBe('income');
    expect(cat('Аванс', 3_650_000, { mcc: 4829 })).toBe('income');
    expect(
      cat('Оплата за послуги згідно договору №12', 4_500_000, {
        mcc: 4829,
        fop: true,
        counterparty: 'ТОВ «Нова Лінія»',
      }),
    ).toBe('income');
  });

  it('lets a transfer note say what it was for', () => {
    expect(cat('Кому: Марина В.', -1_600_000, { mcc: 4829, comment: 'Оренда' })).toBe('bills');
  });

  it('files unknown spending as other and unknown money in as income', () => {
    expect(cat('SOME UNKNOWN SHOP', -1_000)).toBe('other');
    expect(cat('Payment from friend', 4_000)).toBe('income');
  });

  it('files refunds under the merchant, not under income', () => {
    expect(cat('Rozetka', 250_000, { mcc: 5311 })).toBe('shopping');
  });
});

describe('secrets inside links', () => {
  it('masks a resource token wherever a link carries it, and leaves other links exactly as they were', () => {
    expect(maskUrlSecrets('https://bank.example/pay?payment_id=p1&resource_token=SECRET')).toBe(
      'https://bank.example/pay?payment_id=p1&resource_token=[redacted]',
    );
    expect(maskUrlSecrets('https://bank.example/pay#resource_token=SECRET&x=1')).toBe(
      'https://bank.example/pay#resource_token=[redacted]&x=1',
    );
    expect(maskUrlSecrets('https://bank.example')).toBe('https://bank.example');
    expect(maskUrlSecrets('https://bank.example/a?b=c#frag')).toBe(
      'https://bank.example/a?b=c#frag',
    );
    expect(maskUrlSecrets('https://bank.example/a?%63ode=SECRET')).toBe(
      'https://bank.example/a?%63ode=[redacted]',
    );
  });

  it('finds them inside response bodies, at any depth', () => {
    const body = {
      id: 'p1',
      hosted_page: { uri: 'https://bank.example/pay?payment_id=p1&resource_token=SECRET' },
      links: ['https://bank.example/pay#resource_token=SECRET2', 'https://docs.example/guide'],
      note: 'see https://bank.example/pay?resource_token=SECRET3 for details',
    };
    const redacted = JSON.stringify(redactJson(body, { maskIdentifiers: false }));
    expect(redacted).not.toContain('SECRET"');
    expect(redacted).not.toContain('SECRET2');
    expect(redacted).toContain('payment_id=p1&resource_token=[redacted]');
    expect(redacted).toContain('https://docs.example/guide');
  });
});
