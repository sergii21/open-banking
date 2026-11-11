/**
 * The text decoder the statement readers use. UKRSIB exports Windows-1251, and the reader tries strict UTF-8 first and
 * falls back to it; a phone's built-in decoder is not known to do either, so the app brings its own: UTF-8 (strict or
 * forgiving), UTF-16 and Windows-1251, written out here and the same on every device.
 */

// Windows-1251, bytes 0x80 to 0xBF. 0xC0 to 0xFF are the letters А to я in order (U+0410 to U+044F).
const CP1251_HIGH: readonly number[] = [
  0x0402, 0x0403, 0x201a, 0x0453, 0x201e, 0x2026, 0x2020, 0x2021, 0x20ac, 0x2030, 0x0409, 0x2039,
  0x040a, 0x040c, 0x040b, 0x040f, 0x0452, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x0098, 0x2122, 0x0459, 0x203a, 0x045a, 0x045c, 0x045b, 0x045f, 0x00a0, 0x040e, 0x045e, 0x0408,
  0x00a4, 0x0490, 0x00a6, 0x00a7, 0x0401, 0x00a9, 0x0404, 0x00ab, 0x00ac, 0x00ad, 0x00ae, 0x0407,
  0x00b0, 0x00b1, 0x0406, 0x0456, 0x0491, 0x00b5, 0x00b6, 0x00b7, 0x0451, 0x2116, 0x0454, 0x00bb,
  0x0458, 0x0405, 0x0455, 0x0457,
];

export function decodeWindows1251(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    if (byte < 0x80) out += String.fromCharCode(byte);
    else if (byte >= 0xc0) out += String.fromCharCode(0x410 + byte - 0xc0);
    else out += String.fromCharCode(CP1251_HIGH[byte - 0x80] ?? 0xfffd);
  }
  return out;
}

/** With `fatal`, anything that is not well-formed UTF-8 throws; without, it becomes U+FFFD. */
export function decodeUtf8(bytes: Uint8Array, fatal: boolean): string {
  let out = '';
  const bad = (): void => {
    if (fatal) throw new TypeError('The text is not valid UTF-8.');
    out += String.fromCharCode(0xfffd);
  };
  for (let i = 0; i < bytes.length; i++) {
    const first = bytes[i] ?? 0;
    if (first < 0x80) {
      out += String.fromCharCode(first);
      continue;
    }
    const length = first >= 0xf0 && first <= 0xf4 ? 4 : first >= 0xe0 ? 3 : first >= 0xc2 ? 2 : 0;
    if (length === 0 || first > 0xf4) {
      bad();
      continue;
    }
    let code = first & (0xff >> (length + 1));
    let ok = i + length <= bytes.length;
    for (let j = 1; ok && j < length; j++) {
      const next = bytes[i + j] ?? 0;
      if ((next & 0xc0) !== 0x80) ok = false;
      else code = (code << 6) | (next & 0x3f);
    }
    const least = length === 2 ? 0x80 : length === 3 ? 0x800 : 0x10000;
    if (!ok || code < least || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      bad();
      continue;
    }
    out += String.fromCodePoint(code);
    i += length - 1;
  }
  return out;
}

export function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
  let out = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    out += String.fromCharCode(littleEndian ? a | (b << 8) : (a << 8) | b);
  }
  return out;
}

type Label = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1251';
const LABELS: Readonly<Record<string, Label>> = {
  'utf-8': 'utf-8',
  utf8: 'utf-8',
  'utf-16le': 'utf-16le',
  'utf-16': 'utf-16le',
  'utf-16be': 'utf-16be',
  'windows-1251': 'windows-1251',
  cp1251: 'windows-1251',
};

export class LedgerTextDecoder {
  readonly encoding: Label;
  readonly fatal: boolean;
  readonly ignoreBOM = false;

  constructor(label = 'utf-8', options: { fatal?: boolean } = {}) {
    const known = LABELS[label.trim().toLowerCase()];
    if (!known) throw new RangeError(`This app cannot read text in ${label}.`);
    this.encoding = known;
    this.fatal = options.fatal === true;
  }

  decode(input?: ArrayBuffer | ArrayBufferView): string {
    if (input === undefined) return '';
    const bytes = ArrayBuffer.isView(input)
      ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
      : new Uint8Array(input);
    switch (this.encoding) {
      case 'utf-8': {
        const text = decodeUtf8(bytes, this.fatal);
        return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
      }
      case 'utf-16le':
        return decodeUtf16(bytes, true);
      case 'utf-16be':
        return decodeUtf16(bytes, false);
      case 'windows-1251':
        return decodeWindows1251(bytes);
    }
  }
}

/** Puts the decoder where the reused readers look for it. Called once, before they load (`index.ts`). */
export function installTextDecoder(target: { TextDecoder?: unknown } = globalThis): void {
  target.TextDecoder = LedgerTextDecoder;
}

installTextDecoder();
