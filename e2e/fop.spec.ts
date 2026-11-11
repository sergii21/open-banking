import { expect, test, type Page } from '@playwright/test';
import { expectNoViolations, expectNothingPastTheEdge, settle, watchCsp } from './support';

// The ФОП report: UKRSIB business statements (CSV) become income per quarter, with the single tax and the military levy. The files
// are made up in the real export's layout (fixtures/ukrsib, scripts/make-ukrsib-fixtures.ts); Home comes from a Privat24 file.
const PRIVAT24 = 'fixtures/privat24/unverified-statement.csv';
const UAH = 'fixtures/ukrsib/made-up-uah.csv';
const EUR = 'fixtures/ukrsib/made-up-eur.csv';
const ALL = 'fixtures/ukrsib/made-up-all-accounts.csv';

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
  context,
}) => {
  const violations = await watchCsp(page);
  const sheet = await openReport(page);
  await expect(sheet.getByText('Nothing here yet')).toBeVisible();

  // Before anything is loaded the calendar already shows the year's four declarations and asks for statements.
  const calendar = sheet.locator('.fop-cal li');
  await expect(calendar).toHaveCount(4);
  await expect(calendar.nth(0)).toContainText('I квартал');
  await expect(calendar.nth(0)).toContainText('Add statements');
  await expect(calendar.nth(2)).toContainText('file by 09.11.2026 · pay by 19.11.2026');

  // The way through, with the two places it happens in.
  await sheet.getByText('How to: export, import, file').click();
  await expect(sheet.getByRole('link', { name: 'UKRSIB business: Виписки' })).toHaveAttribute(
    'href',
    'https://business.ukrsibbank.com/extracts/statements',
  );
  await expect(
    sheet.getByRole('link', { name: 'Електронний кабінет: Введення звітності' }),
  ).toHaveAttribute('href', 'https://cabinet.tax.gov.ua/reporting');

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

  // The calendar: two quarters paid (the statements hold the payments), the third short of statements, the fourth running.
  await expect(calendar.nth(0)).toContainText('Tax paid');
  await expect(calendar.nth(1)).toContainText('Tax paid');
  await expect(calendar.nth(2)).toContainText('Statements end too early');
  await expect(calendar.nth(2)).toContainText('The latest row is 03.08.2026');
  await expect(calendar.nth(3)).toContainText('Quarter in progress');
  await sheet.getByRole('button', { name: 'Mark as filed: півріччя' }).click();
  await expect(calendar.nth(1)).toContainText('Filed, tax paid');
  await page.reload();
  await page.getByRole('button', { name: 'ФОП report' }).click();
  await expect(calendar.nth(1)).toContainText('Filed, tax paid');
  await sheet.getByRole('button', { name: 'Not filed yet: півріччя' }).click();
  await expect(calendar.nth(1)).toContainText('Tax paid');

  // The lines of the half-year declaration, as the tax cabinet's form takes them.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await second.getByText('Lines for the declaration: півріччя 2026').click();
  const lines = second.locator('.fop-lines li');
  await expect(lines).toHaveCount(10);
  await expect(lines.nth(0)).toContainText('06');
  await expect(lines.nth(0)).toContainText('541000.00');
  await expect(lines.nth(4)).toContainText('14000.00');
  await second.getByRole('button', { name: 'Copy line 14.1, півріччя' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('13050.00');

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
  await sheet.getByText('Lines for the declaration: I квартал 2026').click();
  await expect(sheet.locator('.fop-q').first().locator('.fop-lines li')).toHaveCount(10);
  await expectNothingPastTheEdge(page);
  await expectNoViolations(page);
});

test('without a bank: the report opens from the first screen, and one file with every account is not counted twice', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'ФОП report from UKRSIB statements' }).click();
  const sheet = page.getByRole('dialog', { name: 'ФОП report' });
  await sheet.locator('#fop-file').setInputFiles(ALL);
  await expect(sheet.getByRole('status').first()).toContainText('Read 22 rows (22 new');
  // The euro receipts pass through the bank's transit account first: the year is still 661 500.
  await expect(sheet.locator('.fop-year')).toContainText('661 500');
  await expect(sheet.getByText('On the transit account').first()).toBeVisible();
  await settle(page);
  await expectNoViolations(page);
});
