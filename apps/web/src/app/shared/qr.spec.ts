import { QR_MAX_BYTES, qrBadgeDiameter, qrCode, qrPath } from './qr';

const at = (code: { size: number; modules: Uint8Array }, row: number, col: number): number =>
  code.modules[row * code.size + col] ?? -1;

describe('the QR encoder', () => {
  it('keeps to versions 10 to 17, at Q while the text fits and M after that', () => {
    expect(qrCode('https://qr.bank.gov.ua/short')).toMatchObject({
      version: 10,
      level: 'Q',
      size: 57,
    });
    expect(qrCode('a'.repeat(151))).toMatchObject({ version: 10, level: 'Q' });
    expect(qrCode('a'.repeat(152))).toMatchObject({ version: 11, level: 'Q' });
    expect(qrCode('a'.repeat(364))).toMatchObject({ version: 17, level: 'Q', size: 85 });
    expect(qrCode('a'.repeat(365))).toMatchObject({ version: 15, level: 'M' });
    expect(QR_MAX_BYTES).toBe(504);
    expect(qrCode('a'.repeat(504))).toMatchObject({ version: 17, level: 'M' });
    expect(qrCode('a'.repeat(505))).toBeNull();
    expect(qrCode('щ'.repeat(253))).toBeNull(); // Two bytes each.
  });

  it('draws the three finders, the timing line and the dark module where a reader looks for them', () => {
    const code = qrCode('https://qr.bank.gov.ua/short');
    if (!code) throw new Error('no code');
    const { size } = code;
    for (const [row, col] of [
      [0, 0],
      [0, size - 7],
      [size - 7, 0],
    ] as const) {
      expect(at(code, row, col)).toBe(1);
      expect(at(code, row + 1, col + 1)).toBe(0);
      expect(at(code, row + 3, col + 3)).toBe(1);
      expect(at(code, row + 6, col + 6)).toBe(1);
    }
    for (let i = 8; i < size - 8; i++) expect(at(code, 6, i)).toBe(i % 2 === 0 ? 1 : 0);
    expect(at(code, size - 8, 8)).toBe(1);
  });

  it('writes the same format bits twice, and they pass their own check', () => {
    const code = qrCode('https://qr.bank.gov.ua/short');
    if (!code) throw new Error('no code');
    const { size } = code;
    const first = [
      ...[0, 1, 2, 3, 4, 5, 7, 8].map((row) => at(code, row, 8)),
      ...[7, 5, 4, 3, 2, 1, 0].map((col) => at(code, 8, col)),
    ];
    const second = [
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => at(code, 8, size - 1 - i)),
      ...[8, 9, 10, 11, 12, 13, 14].map((i) => at(code, size - 15 + i, 8)),
    ];
    expect(second).toEqual(first);
    let word = first.reduce((bits, bit, i) => bits | (bit << i), 0) ^ 0x5412;
    expect(word >> 13).toBe(3); // Level Q.
    for (let i = 14; i >= 10; i--) if (word & (1 << i)) word ^= 0x537 << (i - 10);
    expect(word).toBe(0);
  });

  it('is the same code every time, and one path covers every dark module', () => {
    const text = 'https://qr.bank.gov.ua/QkNECjAwMwoxClVDVAo';
    const a = qrCode(text);
    const b = qrCode(text);
    if (!a || !b) throw new Error('no code');
    expect(Array.from(a.modules)).toEqual(Array.from(b.modules));
    const covered = [...qrPath(a).matchAll(/h(\d+)v1/g)].reduce((sum, m) => sum + Number(m[1]), 0);
    expect(covered).toBe(a.modules.reduce((sum, m) => sum + m, 0));
  });

  it('sizes the hryvnia circle from 17 to 25 modules', () => {
    expect(qrBadgeDiameter(10)).toBe(17);
    expect(qrBadgeDiameter(17)).toBe(25);
  });
});
