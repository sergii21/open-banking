import { crc32, deflateRawSync } from 'node:zlib';

/**
 * Statement files for the tests, built here because there is no real Privat24 export to copy: the layout is the one people
 * who have seen an export described (a title row, then Дата, Категорія, Картка, Опис операції, Сума в валюті картки, Валюта
 * картки, Сума в валюті транзакції, Валюта транзакції, Залишок на кінець періоду, Валюта залишку). Every name, amount and
 * card number is made up. UNVERIFIED against the real thing.
 */
export type Cell = string | number | { serial: number };

export const TITLE = 'Виписка з Ваших карток за період 01.09.2026 - 30.09.2026';
export const HEADERS = [
  'Дата',
  'Категорія',
  'Картка',
  'Опис операції',
  'Сума в валюті картки',
  'Валюта картки',
  'Сума в валюті транзакції',
  'Валюта транзакції',
  'Залишок на кінець періоду',
  'Валюта залишку',
];

/** Newest first, the way a bank lists them. Two cards; two identical rides in the same minute; one purchase abroad. */
export const DATA: Cell[][] = [
  [
    '30.09.2026 18:42:10',
    'Супермаркети',
    '5168 74** **** 1234',
    'Сільпо, Київ',
    -412.8,
    'UAH',
    -412.8,
    'UAH',
    15230.55,
    'UAH',
  ],
  [
    '29.09.2026 09:15:00',
    'Транспорт',
    '5168 74** **** 1234',
    'Uklon',
    -95,
    'UAH',
    -95,
    'UAH',
    15643.35,
    'UAH',
  ],
  [
    '29.09.2026 09:15:00',
    'Транспорт',
    '5168 74** **** 1234',
    'Uklon',
    -95,
    'UAH',
    -95,
    'UAH',
    15738.35,
    'UAH',
  ],
  [
    '27.09.2026 12:00:00',
    'Надходження',
    '5168 74** **** 1234',
    'Зарахування заробітної плати',
    25000,
    'UAH',
    25000,
    'UAH',
    15833.35,
    'UAH',
  ],
  [
    '26.09.2026 20:31:44',
    'Підписки',
    '5168 74** **** 1234',
    'NETFLIX.COM',
    -299,
    'UAH',
    -7.5,
    'USD',
    -9166.65,
    'UAH',
  ],
  [
    '22.09.2026 13:20:05',
    'Кафе та ресторани',
    '5168 74** **** 1234',
    'Aroma Kava',
    -148.5,
    'UAH',
    -148.5,
    'UAH',
    -8867.65,
    'UAH',
  ],
  [
    '18.09.2026 08:05:30',
    'Комунальні платежі',
    '5168 74** **** 1234',
    'Оплата Київстар',
    -250,
    'UAH',
    -250,
    'UAH',
    -8719.15,
    'UAH',
  ],
  [
    '15.09.2026 17:00:00',
    'Поповнення',
    '4149 49** **** 5678',
    'Переказ від Олена К.',
    3000,
    'UAH',
    3000,
    'UAH',
    5100,
    'UAH',
  ],
  [
    '12.09.2026 11:11:11',
    'Супермаркети',
    '4149 49** **** 5678',
    'АТБ-Маркет',
    -520.4,
    'UAH',
    -520.4,
    'UAH',
    2100,
    'UAH',
  ],
  [
    '03.09.2026 19:45:00',
    'Аптеки',
    '4149 49** **** 5678',
    'Аптека Доброго Дня',
    -312,
    'UAH',
    -312,
    'UAH',
    2620.4,
    'UAH',
  ],
  [
    '02.09.2026 10:00:00',
    'Кафе та ресторани',
    '4149 49** **** 5678',
    'Мiсто Кава',
    -85,
    'UAH',
    -85,
    'UAH',
    2932.4,
    'UAH',
  ],
];

/** The statement as an Excel sheet or a CSV would hold it: title, blank line, headers, rows. */
export const table = (data: Cell[][] = DATA, headers: string[] = HEADERS): Cell[][] => [
  [TITLE],
  [],
  headers,
  ...data,
];

// ------------------------------------------------------------------------------------------------ zip and xlsx

const u16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};

/** A minimal zip writer: enough for a spreadsheet, deflated unless asked to store. */
export function zip(
  files: Record<string, string | Buffer>,
  options: { store?: boolean; lie?: number } = {},
): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const packed = options.store ? data : deflateRawSync(data);
    const method = options.store ? 0 : 8;
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const declared = options.lie ?? data.length;
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(method),
      u16(0),
      u16(0),
      u32(crc),
      u32(packed.length),
      u32(declared),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
      packed,
    ]);
    central.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(method),
        u16(0),
        u16(0),
        u32(crc),
        u32(packed.length),
        u32(declared),
        u16(nameBytes.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBytes,
      ]),
    );
    locals.push(local);
    offset += local.length;
  }
  const directory = Buffer.concat(central);
  return Buffer.concat([
    ...locals,
    directory,
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(central.length),
    u16(central.length),
    u32(directory.length),
    u32(offset),
    u16(0),
  ]);
}

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const letters = (index: number): string => {
  let out = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  return out;
};

export interface XlsxOptions {
  /** Where text lives: the shared string table (what Excel writes) or in the cell itself. */
  strings?: 'shared' | 'inline';
  store?: boolean;
}

/** An .xlsx workbook with one sheet. A `{ serial }` cell is a number shown with a date format, as Excel stores dates. */
export function buildXlsx(rows: Cell[][], options: XlsxOptions = {}): Buffer {
  const shared: string[] = [];
  const sharedIndex = (text: string): number => {
    const found = shared.indexOf(text);
    if (found >= 0) return found;
    shared.push(text);
    return shared.length - 1;
  };
  const sheetRows = rows
    .map((row, r) => {
      const cells = row
        .map((cell, c) => {
          const ref = `${letters(c)}${r + 1}`;
          if (typeof cell === 'number') return `<c r="${ref}"><v>${cell}</v></c>`;
          if (typeof cell === 'object') return `<c r="${ref}" s="1"><v>${cell.serial}</v></c>`;
          if (options.strings === 'inline') {
            return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell)}</t></is></c>`;
          }
          return `<c r="${ref}" t="s"><v>${sharedIndex(cell)}</v></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  return zip(
    {
      '[Content_Types].xml':
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
      'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Виписка" sheetId="1" r:id="rId7"/></sheets></workbook>`,
      'xl/_rels/workbook.xml.rels':
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId7" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/styles.xml': `<?xml version="1.0"?><styleSheet xmlns="${ns}"><numFmts count="1"><numFmt numFmtId="164" formatCode="dd\\.mm\\.yyyy\\ hh:mm:ss"/></numFmts><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>`,
      'xl/sharedStrings.xml': `<?xml version="1.0"?><sst xmlns="${ns}" count="${shared.length}" uniqueCount="${shared.length}">${shared.map((s) => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`).join('')}</sst>`,
      'xl/worksheets/sheet1.xml': `<?xml version="1.0"?><worksheet xmlns="${ns}"><sheetData>${sheetRows}</sheetData></worksheet>`,
    },
    { ...(options.store ? { store: true } : {}) },
  );
}

/** Excel's serial number for a local date and time: days since 1899-12-30. */
export const serial = (iso: string): { serial: number } => ({
  serial: (Date.parse(`${iso}Z`) - Date.UTC(1899, 11, 30)) / 86_400_000,
});

// ------------------------------------------------------------------------------------------------------------ csv

const CP1251: Record<string, number> = {
  Ё: 0xa8,
  ё: 0xb8,
  Є: 0xaa,
  є: 0xba,
  І: 0xb2,
  і: 0xb3,
  Ї: 0xaf,
  ї: 0xbf,
  Ґ: 0xa5,
  ґ: 0xb4,
  '№': 0xb9,
  '–': 0x96,
  '—': 0x97,
  '−': 0x2d,
};

/** Windows-1251 bytes for a text (the Cyrillic letters, digits and punctuation a statement uses). */
export function encodeCp1251(text: string): Buffer {
  return Buffer.from(
    [...text].map((char) => {
      const code = char.charCodeAt(0);
      if (code < 0x80) return code;
      if (code >= 0x410 && code <= 0x44f) return code - 0x410 + 0xc0;
      return CP1251[char] ?? 0x3f;
    }),
  );
}

export interface CsvOptions {
  delimiter?: ';' | ',' | '\t';
  encoding?: 'utf8' | 'utf8-bom' | 'cp1251';
  /** Write amounts the Ukrainian way, with a decimal comma. */
  decimalComma?: boolean;
}

export function buildCsv(rows: Cell[][], options: CsvOptions = {}): Buffer {
  const delimiter = options.delimiter ?? ';';
  const text = rows
    .map((row) =>
      row
        .map((cell) => {
          const value =
            typeof cell === 'number'
              ? options.decimalComma
                ? String(cell).replace('.', ',')
                : String(cell)
              : typeof cell === 'object'
                ? String(cell.serial)
                : cell;
          return /["\n;,\t]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
        })
        .join(delimiter),
    )
    .join('\r\n');
  if (options.encoding === 'cp1251') return encodeCp1251(text);
  const bytes = Buffer.from(text, 'utf8');
  return options.encoding === 'utf8-bom'
    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])
    : bytes;
}
