import { readZip, ZipError } from './zip';

/**
 * The first worksheet of an .xlsx workbook as rows of text. Reads only what a bank statement needs from the OOXML format: the
 * workbook's sheet list, shared strings, the cell styles that say a number is a date, and the sheet's cells. Numbers come out
 * as the text Excel stored; a number in a date format comes out as `dd.mm.yyyy hh:mm:ss`. Formulas are not evaluated (the
 * value Excel cached with them is used), macros and external links are never looked at.
 */
export function readXlsx(file: Buffer): string[][] {
  const files = readZip(
    file,
    (name) =>
      name === 'xl/workbook.xml' ||
      name === 'xl/_rels/workbook.xml.rels' ||
      name === 'xl/sharedStrings.xml' ||
      name === 'xl/styles.xml' ||
      /^xl\/worksheets\/[^/]+\.xml$/.test(name),
  );
  const text = (name: string): string => files.get(name)?.toString('utf8') ?? '';

  const sheetPath = firstSheet(text('xl/workbook.xml'), text('xl/_rels/workbook.xml.rels'), files);
  if (!sheetPath) throw new ZipError('the workbook has no worksheet');
  const strings = sharedStrings(text('xl/sharedStrings.xml'));
  const dateStyles = styleDates(text('xl/styles.xml'));
  return sheetRows(text(sheetPath), strings, dateStyles);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function unescapeXml(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x')) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return ENTITIES[body] ?? whole;
  });
}

const attributes = (tag: string): Map<string, string> => {
  const found = new Map<string, string>();
  for (const match of tag.matchAll(/([A-Za-z_][\w:.-]*)="([^"]*)"/g)) {
    found.set(match[1] ?? '', unescapeXml(match[2] ?? ''));
  }
  return found;
};

/** The concatenated `<t>` text of a rich-text run list, without phonetic hints. */
function runText(xml: string): string {
  const withoutPhonetics = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const match of withoutPhonetics.matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)) {
    out += unescapeXml(match[1] ?? '');
  }
  return out;
}

function firstSheet(workbook: string, rels: string, files: Map<string, Buffer>): string | null {
  const sheet = /<sheet\b[^>]*>/.exec(workbook)?.[0];
  const relId = sheet ? attributes(sheet).get('r:id') : undefined;
  if (relId) {
    for (const match of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      const rel = attributes(match[0]);
      if (rel.get('Id') === relId && rel.get('Target')) {
        const target = rel.get('Target') ?? '';
        const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
        if (files.has(path)) return path;
      }
    }
  }
  // Fall back to the lowest-numbered worksheet part.
  return (
    [...files.keys()]
      .filter((name) => name.startsWith('xl/worksheets/'))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))[0] ?? null
  );
}

function sharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)].map((m) => runText(m[1] ?? ''));
}

const BUILTIN_DATE_FORMATS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51,
  52, 53, 54, 55, 56, 57, 58,
]);

const isDateCode = (code: string): boolean => {
  const stripped = code.replace(/"[^"]*"|\\.|\[[^\]]*\]|_.|\*./g, '');
  return /[dmyhs]/i.test(stripped) && !/^general$/i.test(stripped);
};

/** For each cell style (by index): does it show a number as a date or time? */
function styleDates(xml: string): boolean[] {
  const custom = new Map<number, string>();
  for (const match of xml.matchAll(/<numFmt\b[^>]*>/g)) {
    const attrs = attributes(match[0]);
    custom.set(Number(attrs.get('numFmtId')), attrs.get('formatCode') ?? '');
  }
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? '';
  return [...cellXfs.matchAll(/<xf\b[^>]*>/g)].map((match) => {
    const id = Number(attributes(match[0]).get('numFmtId') ?? 0);
    const code = custom.get(id);
    return code !== undefined ? isDateCode(code) : BUILTIN_DATE_FORMATS.has(id);
  });
}

/** Excel's serial day number to `dd.mm.yyyy hh:mm:ss` (the serial counts days from 1899-12-30; the clock is the workbook's own). */
function serialToText(serial: number): string {
  const ms = Math.round((serial - 25_569) * 86_400_000);
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

const MAX_COLUMNS = 200;

function columnIndex(reference: string): number {
  let index = 0;
  for (const letter of /^[A-Z]+/i.exec(reference)?.[0].toUpperCase() ?? '') {
    index = index * 26 + (letter.charCodeAt(0) - 64);
  }
  return index - 1;
}

function sheetRows(
  xml: string,
  strings: readonly string[],
  dateStyles: readonly boolean[],
): string[][] {
  const rows: string[][] = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row: string[] = [];
    let next = 0;
    for (const cellMatch of (rowMatch[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = attributes(cellMatch[1] ?? '');
      const body = cellMatch[2] ?? '';
      const column = attrs.has('r') ? columnIndex(attrs.get('r') ?? '') : next;
      next = column + 1;
      if (column < 0 || column >= MAX_COLUMNS) continue;

      const type = attrs.get('t') ?? 'n';
      const raw = unescapeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      let value: string;
      if (type === 's') value = strings[Number(raw)] ?? '';
      else if (type === 'inlineStr')
        value = runText(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '');
      else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
      else if (type === 'e') value = '';
      else if (type === 'str' || type === 'd') value = raw;
      else if (raw !== '' && Number.isFinite(Number(raw))) {
        value = dateStyles[Number(attrs.get('s') ?? 0)] ? serialToText(Number(raw)) : raw;
      } else value = raw;
      while (row.length < column) row.push('');
      row[column] = value;
    }
    rows.push(row);
  }
  return rows;
}
