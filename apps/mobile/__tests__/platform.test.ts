import { createHash as realHash } from 'crypto';
import { TextDecoder as NodeDecoder } from 'util';
import { createHash } from '../src/platform/node-crypto';
import { LedgerTextDecoder, installTextDecoder } from '../src/platform/text-decoder';

const TEXTS = [
  '',
  'abc',
  'Оплата за послуги згідно рахунку №17 від 03.11.2026',
  '2026-05-10\u0001UA\u00011500000\u00010',
  'x'.repeat(55),
  'x'.repeat(56),
  'x'.repeat(64),
  'ї€😀'.repeat(300),
];

describe('the stand-in for node:crypto', () => {
  it.each(['sha256', 'sha1'] as const)('%s gives what Node gives', (algorithm) => {
    for (const text of TEXTS) {
      expect(createHash(algorithm).update(text).digest('hex')).toBe(
        realHash(algorithm).update(text).digest('hex'),
      );
      expect(createHash(algorithm).update(text).digest('base64url')).toBe(
        realHash(algorithm).update(text).digest('base64url'),
      );
      expect(createHash(algorithm).update(text).digest().readUInt32LE(0)).toBe(
        realHash(algorithm).update(text).digest().readUInt32LE(0),
      );
    }
  });

  it('adds up several updates', () => {
    expect(createHash('sha256').update('ab').update('c').digest('hex')).toBe(
      realHash('sha256').update('abc').digest('hex'),
    );
  });

  it('refuses a hash it does not have', () => {
    expect(() => createHash('md5')).toThrow();
  });
});

describe('the text decoder', () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);

  it('reads every Windows-1251 byte as Node does', () => {
    expect(new LedgerTextDecoder('windows-1251').decode(all)).toBe(
      new NodeDecoder('windows-1251').decode(all),
    );
  });

  it('reads UTF-8 and refuses what is not, when asked to be strict', () => {
    const text = 'Дата операцiї; сума 1 500,50 ₴ 😀';
    const bytes = new TextEncoder().encode(text);
    expect(new LedgerTextDecoder('utf-8', { fatal: true }).decode(bytes)).toBe(text);
    const cp1251 = Uint8Array.from([0xc4, 0xe0, 0xf2, 0xe0]);
    expect(() => new LedgerTextDecoder('utf-8', { fatal: true }).decode(cp1251)).toThrow(TypeError);
    expect(new LedgerTextDecoder('utf-8').decode(cp1251)).toBe(new NodeDecoder().decode(cp1251));
    for (const bad of [
      [0xc0, 0x80],
      [0xed, 0xa0, 0x80],
      [0xf5, 0x80, 0x80, 0x80],
      [0xe2, 0x82],
    ]) {
      expect(() =>
        new LedgerTextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bad)),
      ).toThrow(TypeError);
    }
  });

  it('reads UTF-16 both ways round', () => {
    expect(
      new LedgerTextDecoder('utf-16le').decode(Uint8Array.from([0x14, 0x04, 0x41, 0x00])),
    ).toBe('ДA');
    expect(
      new LedgerTextDecoder('utf-16be').decode(Uint8Array.from([0x04, 0x14, 0x00, 0x41])),
    ).toBe('ДA');
  });

  it('is put where the statement readers look for it', () => {
    const target: { TextDecoder?: unknown } = {};
    installTextDecoder(target);
    expect(target.TextDecoder).toBe(LedgerTextDecoder);
    expect(() => new LedgerTextDecoder('koi8-r')).toThrow(RangeError);
  });
});
