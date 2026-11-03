import { inflateRawSync } from 'node:zlib';

export class ZipError extends Error {
  override name = 'ZipError';
}

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_ENTRY = 0x04034b50;

interface Entry {
  name: string;
  method: number;
  encrypted: boolean;
  compressedSize: number;
  size: number;
  localOffset: number;
}

/** The central directory at the end of a zip: where each file is and how big it will be once unpacked. */
function directory(zip: Buffer): Entry[] {
  const earliest = Math.max(0, zip.length - 65_557);
  let end = -1;
  for (let i = zip.length - 22; i >= earliest; i -= 1) {
    if (zip.readUInt32LE(i) === END_OF_DIRECTORY) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new ZipError('not a zip file');
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const entries: Entry[] = [];
  for (let n = 0; n < count; n += 1) {
    if (zip.readUInt32LE(offset) !== DIRECTORY_ENTRY) throw new ZipError('damaged zip directory');
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    entries.push({
      name: zip.toString('utf8', offset + 46, offset + 46 + nameLength),
      method: zip.readUInt16LE(offset + 10),
      encrypted: (zip.readUInt16LE(offset + 8) & 1) === 1,
      compressedSize: zip.readUInt32LE(offset + 20),
      size: zip.readUInt32LE(offset + 24),
      localOffset: zip.readUInt32LE(offset + 42),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * Unpacks the files of a zip whose names `wanted` accepts, and nothing else. Written for spreadsheets a person uploads, so it
 * is strict about size: no unpacked file may pass `limit` bytes (the size the directory claims is checked first, and the
 * inflater is capped as well, so a file that lies about its size still cannot fill memory). Stored and deflated entries only;
 * encrypted and Zip64 archives are refused.
 */
export function readZip(
  zip: Buffer,
  wanted: (name: string) => boolean,
  limit = 32 * 1024 * 1024,
): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  try {
    let total = 0;
    for (const entry of directory(zip)) {
      if (!wanted(entry.name)) continue;
      if (entry.encrypted) throw new ZipError('encrypted zip');
      if (entry.size === 0xffffffff || entry.compressedSize === 0xffffffff) {
        throw new ZipError('zip64 is not supported');
      }
      total += entry.size;
      if (entry.size > limit || total > limit) throw new ZipError('the file unpacks too large');
      if (zip.readUInt32LE(entry.localOffset) !== LOCAL_ENTRY)
        throw new ZipError('damaged zip entry');
      const start =
        entry.localOffset +
        30 +
        zip.readUInt16LE(entry.localOffset + 26) +
        zip.readUInt16LE(entry.localOffset + 28);
      const data = zip.subarray(start, start + entry.compressedSize);
      if (entry.method === 0) files.set(entry.name, Buffer.from(data));
      else if (entry.method === 8)
        files.set(entry.name, inflateRawSync(data, { maxOutputLength: limit }));
      else throw new ZipError('unsupported compression');
    }
  } catch (error) {
    if (error instanceof ZipError) throw error;
    throw new ZipError('damaged zip file');
  }
  return files;
}
