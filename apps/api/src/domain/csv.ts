/**
 * CSV for spreadsheets (RFC 4180: comma separators, CRLF line ends, quotes doubled), written with a byte order mark so Excel
 * reads Cyrillic and accented text as UTF-8.
 *
 * Text that came from a bank or a merchant is untrusted: a description such as `=HYPERLINK(...)` becomes a formula when a
 * spreadsheet opens the file. Such cells are defused with a leading apostrophe (OWASP's CSV injection advice). Numbers we
 * format ourselves from integers are written as they are, because a leading "-" is a sign and not an attack.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

export const defuse = (text: string): string => (FORMULA_START.test(text) ? `'${text}` : text);

const quote = (cell: string): string =>
  /[",\r\n]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;

export type CsvCell = { text: string } | { number: string };

export const text = (value: string | null | undefined): CsvCell => ({ text: value ?? '' });
export const number = (value: string): CsvCell => ({ number: value });

export function toCsv(header: readonly string[], rows: readonly (readonly CsvCell[])[]): string {
  const lines = [
    header.map(quote).join(','),
    ...rows.map((row) =>
      row.map((cell) => ('number' in cell ? cell.number : quote(defuse(cell.text)))).join(','),
    ),
  ];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
