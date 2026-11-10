/**
 * A QR code encoder for the National Bank of Ukraine payment code, and nothing wider: byte mode, versions 10 to 17, error
 * correction Q when the text fits and M when it does not (the standard allows only that range). Written here because the browser
 * ships no library: the sheet that uses it is loaded when first opened.
 */
export type QrLevel = 'M' | 'Q';

export interface QrCode {
  readonly version: number;
  readonly level: QrLevel;
  /** Modules on a side, without the quiet zone. */
  readonly size: number;
  /** Row by row, 1 is dark. */
  readonly modules: Uint8Array;
}

/** Per level: error-correction codewords per block, blocks in the first group, data codewords in each (the second group has one more), blocks in the second group. */
type Blocks = readonly [ec: number, count1: number, data1: number, count2: number];
interface VersionSpec {
  readonly align: readonly number[];
  readonly M: Blocks;
  readonly Q: Blocks;
}

const MIN_VERSION = 10;
const VERSIONS: readonly VersionSpec[] = [
  { align: [6, 28, 50], M: [26, 4, 43, 1], Q: [24, 6, 19, 2] },
  { align: [6, 30, 54], M: [30, 1, 50, 4], Q: [28, 4, 22, 4] },
  { align: [6, 32, 58], M: [22, 6, 36, 2], Q: [26, 4, 20, 6] },
  { align: [6, 34, 62], M: [22, 8, 37, 1], Q: [24, 8, 20, 4] },
  { align: [6, 26, 46, 66], M: [24, 4, 40, 5], Q: [20, 11, 16, 5] },
  { align: [6, 26, 48, 70], M: [24, 5, 41, 5], Q: [30, 5, 24, 7] },
  { align: [6, 26, 50, 74], M: [28, 7, 45, 3], Q: [24, 15, 19, 2] },
  { align: [6, 30, 54, 78], M: [28, 10, 46, 1], Q: [28, 1, 22, 15] },
];
const LEVEL_BITS: Readonly<Record<QrLevel, number>> = { M: 0, Q: 3 };

const dataCodewords = ([, count1, data1, count2]: Blocks): number =>
  count1 * data1 + count2 * (data1 + 1);
/** Byte mode in these versions spends 4 bits on the mode and 16 on the length. */
const capacity = (blocks: Blocks): number => dataCodewords(blocks) - 3;

/** The longest text, in bytes, that still makes a code. */
export const QR_MAX_BYTES = capacity(VERSIONS[VERSIONS.length - 1].M);

// Arithmetic in GF(256) over x^8 + x^4 + x^3 + x^2 + 1, for the Reed–Solomon codewords.
const EXP = new Uint8Array(510);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = EXP[i + 255] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
const multiply = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function generator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    poly.forEach((coefficient, j) => {
      next[j] ^= coefficient;
      next[j + 1] ^= multiply(coefficient, EXP[i]);
    });
    poly = next;
  }
  return poly;
}

function remainder(data: readonly number[], gen: readonly number[]): number[] {
  const rest = new Array<number>(gen.length - 1).fill(0);
  for (const byte of data) {
    const factor = byte ^ (rest.shift() ?? 0);
    rest.push(0);
    for (let i = 0; i < rest.length; i++) rest[i] ^= multiply(gen[i + 1], factor);
  }
  return rest;
}

/** The text as codewords: data blocks interleaved, then their error-correction blocks interleaved. */
function codewords(bytes: Uint8Array, blocks: Blocks): number[] {
  const total = dataCodewords(blocks);
  const data: number[] = [0x40 | (bytes.length >> 12), (bytes.length >> 4) & 0xff];
  let carry = bytes.length & 15;
  for (const byte of bytes) {
    data.push((carry << 4) | (byte >> 4));
    carry = byte & 15;
  }
  data.push(carry << 4); // The last half byte, and the four-bit terminator.
  for (let pad = 0xec; data.length < total; pad ^= 0xec ^ 0x11) data.push(pad);

  const [ec, count1, data1, count2] = blocks;
  const gen = generator(ec);
  const parts: number[][] = [];
  const checks: number[][] = [];
  for (let block = 0, at = 0; block < count1 + count2; block++) {
    const length = data1 + (block < count1 ? 0 : 1);
    const part = data.slice(at, at + length);
    at += length;
    parts.push(part);
    checks.push(remainder(part, gen));
  }
  const out: number[] = [];
  for (let i = 0; i <= data1; i++) for (const part of parts) if (i < part.length) out.push(part[i]);
  for (let i = 0; i < ec; i++) for (const check of checks) out.push(check[i]);
  return out;
}

const MASKS: readonly ((row: number, col: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** The standard's four penalties: long runs, 2×2 blocks, shapes that look like a finder, and an uneven share of dark. */
function penalty(modules: Uint8Array, size: number): number {
  let score = 0;
  let dark = 0;
  for (let line = 0; line < size; line++) {
    for (const horizontal of [true, false]) {
      let run = 0;
      let last = -1;
      let history = 0;
      for (let i = 0; i < size; i++) {
        const value = horizontal ? modules[line * size + i] : modules[i * size + line];
        if (value === last) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score++;
        } else {
          run = 1;
          last = value;
        }
        history = ((history << 1) | value) & 0x7ff;
        // 1011101 with four light modules on either side.
        if (i >= 10 && (history === 0b10111010000 || history === 0b00001011101)) score += 40;
      }
    }
  }
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const value = modules[row * size + col];
      dark += value;
      if (
        row + 1 < size &&
        col + 1 < size &&
        value === modules[row * size + col + 1] &&
        value === modules[(row + 1) * size + col] &&
        value === modules[(row + 1) * size + col + 1]
      ) {
        score += 3;
      }
    }
  }
  return score + Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
}

/** Null when the text is longer than a version 17 code holds. */
export function qrCode(text: string): QrCode | null {
  const bytes = new TextEncoder().encode(text);
  let level: QrLevel = 'Q';
  let index = VERSIONS.findIndex((v) => capacity(v.Q) >= bytes.length);
  if (index < 0) {
    level = 'M';
    index = VERSIONS.findIndex((v) => capacity(v.M) >= bytes.length);
  }
  const spec = VERSIONS[index];
  if (!spec) return null;
  const version = MIN_VERSION + index;
  const size = version * 4 + 17;
  const base = new Uint8Array(size * size);
  const fixed = new Uint8Array(size * size);
  const set = (row: number, col: number, dark: boolean | number): void => {
    base[row * size + col] = dark ? 1 : 0;
    fixed[row * size + col] = 1;
  };

  // Timing lines, then the three finders with their separators, the alignment marks, and the areas kept for format and version.
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [top, left] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ] as const) {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const row = top + dy;
        const col = left + dx;
        if (row < 0 || col < 0 || row >= size || col >= size) continue;
        const ring = Math.max(Math.abs(dy - 3), Math.abs(dx - 3));
        set(row, col, ring !== 2 && ring !== 4);
      }
    }
  }
  const last = spec.align.length - 1;
  spec.align.forEach((row, i) =>
    spec.align.forEach((col, j) => {
      if ((i === 0 && (j === 0 || j === last)) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(row + dy, col + dx, Math.max(Math.abs(dy), Math.abs(dx)) !== 1);
        }
      }
    }),
  );
  const format = (bits: number, target: Uint8Array | null): void => {
    const put = (row: number, col: number, i: number): void => {
      if (target) target[row * size + col] = (bits >> i) & 1;
      else set(row, col, 0);
    };
    for (let i = 0; i <= 5; i++) put(i, 8, i);
    put(7, 8, 6);
    put(8, 8, 7);
    put(8, 7, 8);
    for (let i = 9; i < 15; i++) put(8, 14 - i, i);
    for (let i = 0; i < 8; i++) put(8, size - 1 - i, i);
    for (let i = 8; i < 15; i++) put(size - 15 + i, 8, i);
  };
  format(0, null);
  set(size - 8, 8, 1);
  let versionBits = version;
  for (let i = 0; i < 12; i++) versionBits = (versionBits << 1) ^ ((versionBits >> 11) * 0x1f25);
  versionBits |= version << 12;
  for (let i = 0; i < 18; i++) {
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    set(a, b, (versionBits >> i) & 1);
    set(b, a, (versionBits >> i) & 1);
  }

  // The codewords snake up and down in two-module columns from the right, around everything placed above.
  const stream = codewords(bytes, spec[level]);
  let bit = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j;
        const row = ((right + 1) & 2) === 0 ? size - 1 - step : step;
        if (fixed[row * size + col] || bit >= stream.length * 8) continue;
        base[row * size + col] = (stream[bit >> 3] >> (7 - (bit & 7))) & 1;
        bit++;
      }
    }
  }

  let best: Uint8Array | null = null;
  let bestScore = Infinity;
  for (const [number, mask] of MASKS.entries()) {
    const modules = base.slice();
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        if (!fixed[row * size + col] && mask(row, col)) modules[row * size + col] ^= 1;
      }
    }
    const data = (LEVEL_BITS[level] << 3) | number;
    let check = data;
    for (let i = 0; i < 10; i++) check = (check << 1) ^ ((check >> 9) * 0x537);
    format(((data << 10) | check) ^ 0x5412, modules);
    const score = penalty(modules, size);
    if (score < bestScore) {
      bestScore = score;
      best = modules;
    }
  }
  return best ? { version, level, size, modules: best } : null;
}

/** One SVG path of the dark modules, a unit square each, with runs along a row joined. */
export function qrPath({ size, modules }: QrCode): string {
  let path = '';
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (!modules[row * size + col]) continue;
      let end = col;
      while (end + 1 < size && modules[row * size + end + 1]) end++;
      path += `M${col} ${row}h${end - col + 1}v1h-${end - col + 1}z`;
      col = end;
    }
  }
  return path;
}

/** The hryvnia sign's white circle in the middle: 17 modules across at version 10, 25 at version 17, as the standard asks. */
export const qrBadgeDiameter = (version: number): number =>
  17 + Math.round(((version - MIN_VERSION) * 8) / 7);
