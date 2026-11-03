/**
 * Writes the statement files the Playwright suite uploads (`fixtures/privat24/`). They are built from the layout people who
 * have seen a Privat24 export described, NOT from a real export: nobody on this project has one yet. Every name, amount and
 * card number is made up. Run `npx tsx scripts/make-privat24-fixtures.ts` after changing `apps/api/test/privat24-fixtures.ts`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { buildCsv, buildXlsx, table } from '../apps/api/test/privat24-fixtures';

const dir = new URL('../fixtures/privat24/', import.meta.url);
mkdirSync(dir, { recursive: true });
writeFileSync(
  new URL('unverified-statement.csv', dir),
  buildCsv(table(), { delimiter: ';', encoding: 'utf8-bom', decimalComma: true }),
);
writeFileSync(new URL('unverified-statement.xlsx', dir), buildXlsx(table()));
process.stdout.write('fixtures/privat24/unverified-statement.{csv,xlsx} written\n');
