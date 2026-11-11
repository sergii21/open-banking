/**
 * Writes the UKRSIB business statements the tests upload (`fixtures/ukrsib/`). The layout is the real export's (read from the
 * author's own, never copied); every name, account and amount is made up. Run `npx tsx scripts/make-ukrsib-fixtures.ts` after
 * changing `apps/api/test/ukrsib-fixtures.ts`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { EUR_LINES, UAH_LINES, ukrsibCsv } from '../apps/api/test/ukrsib-fixtures';

const dir = new URL('../fixtures/ukrsib/', import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(new URL('made-up-uah.csv', dir), ukrsibCsv(UAH_LINES));
writeFileSync(new URL('made-up-eur.csv', dir), ukrsibCsv(EUR_LINES));
process.stdout.write('fixtures/ukrsib/made-up-{uah,eur}.csv written\n');
