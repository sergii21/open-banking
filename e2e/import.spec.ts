import { expect, test } from '@playwright/test';
import { expectNoViolations, expectNothingPastTheEdge, settle, watchCsp } from './support';

// UNVERIFIED: both files are built from the layout of a Privat24 export as it was described, not from a real export (see
// fixtures/privat24 and scripts/make-privat24-fixtures.ts). What these tests prove is the import flow, not the real layout.
const CSV = 'fixtures/privat24/unverified-statement.csv';
const XLSX = 'fixtures/privat24/unverified-statement.xlsx';
const ROWS = 11;

test('importing a Privat24 statement: two cards appear, importing it again counts nothing twice, and a bad file is explained', async ({
  page,
}) => {
  const violations = await watchCsp(page);
  await page.goto('/');
  await page.getByRole('radio', { name: 'Privat24 file' }).click();
  await expect(page.getByText('closed its API in 2022')).toBeVisible();
  await settle(page);
  await expectNoViolations(page);

  // A file that is not a statement is refused with its column titles and none of its values.
  await page.locator('input[type=file]').setInputFiles({
    name: 'other.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Номер;Хто;Що\n1;Сільпо, Київ;25000\n', 'utf8'),
  });
  const refusal = page.getByRole('alert');
  await expect(refusal).toContainText('Columns found: Номер · Хто · Що.');
  await expect(refusal).not.toContainText('Сільпо');
  await expect(page).toHaveURL(/\/welcome|\/$/);

  // The real one: Home opens with two cards, each marked as a statement with the days it covers.
  await page.locator('input[type=file]').setInputFiles(CSV);
  await expect(page).toHaveURL(/\/home/);
  await expect(
    page.getByRole('status').filter({ hasText: `Read ${ROWS} rows from 2 cards` }),
  ).toContainText(`${ROWS} new, 0 already here`);
  await expect(page.locator('.tile')).toHaveCount(2);
  await expect(page.locator('.tile').first()).toContainText('•••• 1234');
  await expect(page.locator('.tile').first()).toContainText('Statement 01.09–30.09');
  await expect(page.locator('.hero > .amt')).toContainText('₴');
  // Both cards have a balance in the file, so both are in the total: 15 230,55 + 5 100,00.
  await expect(page.locator('.hero > .amt')).toContainText('20 330');
  await expect(page.locator('.sync-chip')).toContainText(/Updated/);
  await settle(page);
  await expectNoViolations(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectNoViolations(page);
  await page.emulateMedia({ colorScheme: 'light' });

  await page.getByRole('link', { name: 'Activity' }).click();
  await expect(page.locator('.row')).toHaveCount(ROWS);
  const search = page.getByRole('searchbox', { name: 'Search transactions' });
  await search.fill('Сільпо');
  await expect(page.locator('.row')).toHaveCount(1);
  await search.fill('');
  await expect(page.locator('.row')).toHaveCount(ROWS);

  // Again, as an Excel file this time: the same rows are recognised, not added.
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: /Import another statement/ }).click();
  await expect(page).toHaveURL(/\/connect\?source=privat24/);
  await page.locator('input[type=file]').setInputFiles(XLSX);
  await expect(page).toHaveURL(/\/home/);
  await expect(page.getByRole('status').filter({ hasText: `Read ${ROWS} rows` })).toContainText(
    `0 new, ${ROWS} already here`,
  );
  await page.getByRole('link', { name: 'Activity' }).click();
  await expect(page.locator('.row')).toHaveCount(ROWS);

  // Settings names the file as a connection and removes it with every row.
  await page.getByRole('button', { name: 'Settings' }).click();
  const section = page.getByRole('region', { name: 'Privat24 statement' });
  await expect(section).toContainText('Imported statement');
  await settle(page);
  await expectNoViolations(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectNoViolations(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await section.getByRole('button', { name: /Remove the imported data/ }).click();
  await section.getByRole('button', { name: /Press again to delete everything/ }).click();
  await expect(page).toHaveURL(/\/welcome/);

  expect(await violations()).toEqual([]);
});

test('phone, 320 px: the statement flow and the screens it leads to fit the screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto('/');
  await page.getByRole('radio', { name: 'Privat24 file' }).click();
  await expectNothingPastTheEdge(page);
  await page.locator('input[type=file]').setInputFiles(CSV);
  await expect(page.locator('.tile')).toHaveCount(2);
  await expectNothingPastTheEdge(page);
  await expectNoViolations(page);
  await page.getByRole('link', { name: 'Activity' }).click();
  await page.locator('.row').first().waitFor();
  await expectNothingPastTheEdge(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await expectNothingPastTheEdge(page);
});
