// Ships the built files pre-compressed (brotli and gzip) next to the originals; the API's static handler serves them
// by Accept-Encoding, so nothing is compressed at request time.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const root = new URL('../dist/web/browser', import.meta.url).pathname;
const compressible = new Set(['.js', '.css', '.html', '.svg', '.json', '.txt', '.map']);
let files = 0;
let saved = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (compressible.has(extname(name)) && !name.endsWith('.map')) {
      const input = readFileSync(path);
      if (input.length < 512) continue;
      const br = brotliCompressSync(input, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
      writeFileSync(`${path}.br`, br);
      writeFileSync(`${path}.gz`, gzipSync(input, { level: 9 }));
      files += 1;
      saved += input.length - br.length;
    }
  }
}
walk(root);
process.stdout.write(`precompressed ${files} files, ${(saved / 1024).toFixed(0)} kB saved with brotli\n`);
