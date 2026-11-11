import { expect, test, type Page } from '@playwright/test';
import { expectNoViolations, expectNothingPastTheEdge, settle, watchCsp } from './support';

// The ФОП report: UKRSIB business statements (CSV) become income per quarter, with the single tax and the military levy. The files
// are made up in the real export's layout (fixtures/ukrsib, scripts/make-ukrsib-fixtures.ts); Home comes from a Privat24 file.
const PRIVAT24 = 'fixtures/privat24/unverified-statement.csv';
const UAH = 'fixtures/ukrsib/made-up-uah.csv';
const EUR = 'fixtures/ukrsib/made-up-eur.csv';

async function openReport(page: Page) {
  await page.goto('/');
  await page.getByRole('radio', { name: 'Privat24 file' }).click();
  await page.locator('input[type=file]').setInputFiles(PRIVAT24);
  await expect(page).toHaveURL(/\/home/);
  await page.getByRole('button', { name: 'ФОП report' }).click();
  const sheet = page.getByRole('dialog', { name: 'ФОП report' });
  await expect(sheet).toBeVisible();
  return sheet;
}

test('statements become income per quarter, tax is worked out, and every row can be decided', async ({
  page,
}) => {
  const violations = await watchCsp(page);
  const sheet = await openReport(page);
  await expect(sheet.getByText('Nothing here yet')).toBeVisible();

  // A file that is not a statement is refused with its column titles and none of its values.
  await sheet.locator('#fop-file').setInputFiles({
    name: 'other.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Номер;Хто;Що\n1;Сільпо, Київ;25000\n', 'utf8'),
  });
  const refusal = sheet.getByRole('alert');
  await expect(refusal).toContainText('Columns found: Номер · Хто · Що.');
  await expect(refusal).not.toContainText('Сільпо');

  // The two made-up accounts: 12 hryvnia rows and 4 euro rows.
  await sheet.locator('#fop-file').setInputFiles([UAH, EUR]);
  await expect(sheet.getByRole('status').first()).toContainText(
    'Read 12 rows (12 new, 0 already here)',
  );
  const quarters = sheet.locator('.fop-q');
  await expect(quarters).toHaveCount(4);
  const first = quarters.nth(0);
  await expect(first).toContainText('Quarter 1');
  await expect(first.getByText('Income in the quarter').locator('..')).toContainText('280 000');
  await expect(first.getByText('Single tax for the quarter').locator('..')).toContainText('14 000');
  await expect(first.getByText('Military levy for the quarter').locator('..')).toContainText(
    '2 800',
  );
  await expect(first).toContainText('Matches');
  // Quarter 2: 261 000 earned, 13 050 due, 13 000 paid.
  const second = quarters.nth(1);
  await expect(second.getByText('Income since 1 January').locator('..')).toContainText('541 000');
  await expect(second.getByText('Single tax for the quarter').locator('..')).toContainText(
    '13 050',
  );
  await expect(second).toContainText('Paid less');
  // The year: 661 500 of the limit, and the euro receipts counted at the bank's hryvnia amounts.
  await expect(sheet.locator('.fop-year')).toContainText('661 500');
  await expect(sheet.getByText('6.6% of the 2026 income limit')).toBeVisible();
  await expect(sheet.getByText(/EUR\s+3\s500/)).toBeVisible();

  // The other rate changes the tax and not the levy.
  await sheet.getByRole('radio', { name: '3%' }).click();
  await expect(first.getByText('Single tax for the quarter').locator('..')).toContainText('8 400');
  await expect(first.getByText('Military levy for the quarter').locator('..')).toContainText(
    '2 800',
  );
  await sheet.getByRole('radio', { name: '5%' }).click();

  // The report guessed the sale proceeds are not income; the person says they are, then goes back to the automatic answer.
  const sale = sheet.getByRole('button', { name: /Count it: the 20\.03\.2026 receipt/ });
  await sale.click();
  await expect(first.getByText('Income in the quarter').locator('..')).toContainText('343 200');
  await sheet.getByRole('button', { name: 'Back to automatic' }).click();
  await expect(first.getByText('Income in the quarter').locator('..')).toContainText('280 000');

  await settle(page);
  await expectNoViolations(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectNoViolations(page);
  await page.emulateMedia({ colorScheme: 'light' });

  // The same rows again add nothing.
  await sheet.locator('#fop-file').setInputFiles([UAH]);
  await expect(sheet.getByRole('status').first()).toContainText('0 new, 12 already here');
  await expect(sheet.locator('.fop-year')).toContainText('661 500');

  // Removing them takes two presses and leaves the sheet empty.
  await sheet.getByRole('button', { name: 'Remove the statements' }).click();
  await sheet.getByRole('button', { name: /Press again to remove/ }).click();
  await expect(sheet.getByText('Nothing here yet')).toBeVisible();
  expect(await violations()).toEqual([]);
});

test('phone, 320 px: the report fits the screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const sheet = await openReport(page);
  await sheet.locator('#fop-file').setInputFiles([UAH, EUR]);
  await expect(sheet.locator('.fop-q')).toHaveCount(4);
  await expectNothingPastTheEdge(page);
  await expectNoViolations(page);
});
