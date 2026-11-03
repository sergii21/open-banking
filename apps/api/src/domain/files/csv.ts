/**
 * Text of a file a bank exported. Ukrainian exports are UTF-8 (with or without a byte order mark), UTF-16 from Excel's "Unicode
 * text", or Windows-1251: UTF-8 is tried strictly first, and anything that is not valid UTF-8 is read as Windows-1251.
 */
export function decodeText(file: Buffer): string {
  if (file[0] === 0xff && file[1] === 0xfe)
    return new TextDecoder('utf-16le').decode(file.subarray(2));
  if (file[0] === 0xfe && file[1] === 0xff)
    return new TextDecoder('utf-16be').decode(file.subarray(2));
  const bytes = file[0] === 0xef && file[1] === 0xbb && file[2] === 0xbf ? file.subarray(3) : file;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1251').decode(bytes);
  }
}

/** `;`, tab or `,` — whichever the first lines use most outside quotes. */
function delimiterOf(text: string): string {
  const counts: Record<string, number> = { ';': 0, '\t': 0, ',': 0 };
  let quoted = false;
  let lines = 0;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === '\n') {
      lines += 1;
      if (lines >= 8) break;
    } else if (!quoted && char in counts) counts[char] = (counts[char] ?? 0) + 1;
  }
  return Object.entries(counts).sort(([, a], [, b]) => b - a)[0]?.[0] ?? ',';
}

/** RFC 4180 with the delimiter sniffed: quoted cells may hold delimiters, line breaks and doubled quotes. */
export function readCsv(file: Buffer): string[][] {
  const text = decodeText(file);
  const delimiter = delimiterOf(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const endCell = (): void => {
    row.push(cell);
    cell = '';
  };
  const endRow = (): void => {
    endCell();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? '';
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === '') quoted = true;
    else if (char === delimiter) endCell();
    else if (char === '\n') endRow();
    else if (char !== '\r') cell += char;
  }
  if (cell !== '' || row.length > 0) endRow();
  return rows;
}
