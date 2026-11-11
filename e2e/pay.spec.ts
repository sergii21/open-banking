import { expect, test } from '@playwright/test';
import { connectDemo, expectNoViolations, expectNothingPastTheEdge, watchCsp } from './support';

// Pay from pasted text: the details are read in the browser and become a National Bank of Ukraine payment link and QR code. The
// account below is made up (with correct check digits).
const IBAN = 'UA213223130000026007233566001';
const INVOICE = [
  'Рахунок на оплату № 15 від 10.11.2026',
  'Отримувач: ФОП Шевченко Тарас Григорович',
  'IBAN: UA21 3223 1300 0002 6007 2335 6600 1',
  'ІПН 1234567890',
  'Призначення платежу: Оплата за послуги згідно рахунку № 15',
  'Всього до сплати: 1 500,00 грн',
].join('\n');

test('an invoice becomes a payment code, in the browser alone, and a mistake is explained', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const violations = await watchCsp(page);
  await connectDemo(page);
  await page.getByRole('button', { name: 'Pay from pasted text' }).click();
  const sheet = page.getByRole('dialog', { name: 'Pay from pasted text' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('img')).toHaveCount(0);

  // From here on nothing may go to the server: an invoice is the person's business.
  const calls: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname !== '/api/events') calls.push(request.url());
  });

  await sheet.getByLabel('Invoice or message').fill(INVOICE);
  await expect(sheet.getByLabel('Recipient', { exact: true })).toHaveValue(
    'ФОП Шевченко Тарас Григорович',
  );
  await expect(sheet.getByLabel('Account (IBAN)')).toHaveValue(IBAN);
  await expect(sheet.getByLabel('Recipient’s code')).toHaveValue('1234567890');
  await expect(sheet.getByLabel('Amount, ₴')).toHaveValue('1500,00');
  await expect(sheet.getByLabel('What it is for')).toHaveValue(
    'Оплата за послуги згідно рахунку № 15',
  );
  const code = sheet.getByRole('img', {
    name: /Payment code: ФОП Шевченко Тарас Григорович, 1 500,00 ₴/,
  });
  await expect(code).toBeVisible();

  // The link is the 17 lines of the standard, as the bank app will read them.
  await sheet.getByRole('button', { name: 'Copy the payment link' }).click();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/^https:\/\/qr\.bank\.gov\.ua\/[A-Za-z0-9_-]+$/);
  const fields = Buffer.from(link.split('/').pop() ?? '', 'base64url')
    .toString('utf8')
    .split('\n');
  expect(fields).toHaveLength(17);
  expect(fields.slice(0, 4)).toEqual(['BCD', '003', '1', 'UCT']);
  expect(fields.slice(5, 10)).toEqual([
    'ФОП Шевченко Тарас Григорович',
    IBAN,
    'UAH1500.00',
    '1234567890',
    'OTHR/OTHR',
  ]);
  expect(fields[11]).toBe('Оплата за послуги згідно рахунку № 15');

  // One wrong digit in the account: no code, and the reason in words.
  await sheet.getByLabel('Account (IBAN)').fill('UA213223130000026007233566002');
  await expect(sheet.getByText('its check digits do not match')).toBeVisible();
  await expect(sheet.getByRole('img')).toHaveCount(0);
  await sheet.getByLabel('Account (IBAN)').fill('ua21 3223 1300 0002 6007 2335 6600 1');
  await expect(sheet.getByRole('img')).toBeVisible();

  // No amount is allowed: the person types it in the bank app.
  await sheet.getByLabel('Amount, ₴').fill('');
  await expect(
    sheet.getByRole('img', { name: /the amount is typed in the bank app/ }),
  ).toBeVisible();

  expect(calls).toEqual([]);
  expect(await violations()).toEqual([]);

  // Opening it again starts clean.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Pay from pasted text' }).click();
  await expect(sheet.getByLabel('Invoice or message')).toHaveValue('');
  await expect(sheet.getByRole('img')).toHaveCount(0);
});

test('a card number and an amount become two things to copy, with no payment code', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await connectDemo(page);
  await page.getByRole('button', { name: 'Pay from pasted text' }).click();
  const sheet = page.getByRole('dialog', { name: 'Pay from pasted text' });
  await expect(sheet).toBeVisible();
  const calls: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname !== '/api/events') calls.push(request.url());
  });

  // A scheme's documentation test number: not anybody's card.
  await sheet.getByLabel('Invoice or message').fill('Скинь на 4111 1111 1111 1111\n1 250,50 грн');
  await expect(sheet.getByLabel('Card number')).toHaveText('4111 1111 1111 1111');
  await expect(sheet.getByLabel('Amount, ₴')).toHaveValue('1250,50');
  await expect(sheet.getByLabel('Account (IBAN)')).toHaveCount(0);
  await expect(sheet.getByRole('img')).toHaveCount(0);

  await sheet.getByRole('button', { name: 'Copy the card number' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('4111111111111111');
  await sheet.getByRole('button', { name: 'Copy the amount' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('1250,50');

  // Privat24's transfer form, filled in: a plain link the person follows, nothing the app opens.
  const privat = sheet.getByRole('link', { name: 'Open in Privat24' });
  const form = (await privat.getAttribute('href'))?.split('/money-transfer/form/')[1] ?? '';
  expect(JSON.parse(decodeURIComponent(form))).toEqual({
    form: {
      receiver: { source: 'manual', number: '4111111111111111' },
      amount: 1250.5,
      currency: 'UAH',
    },
  });
  await expect(privat).toHaveAttribute('rel', 'noopener noreferrer');

  // One wrong digit is said in words, and no link is offered.
  await sheet.getByLabel('Invoice or message').fill('4111 1111 1111 1112 500');
  await expect(sheet.getByText('its check digit does not match')).toBeVisible();
  await expect(privat).toHaveCount(0);
  expect(calls).toEqual([]);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`the sheet passes axe and fits 320 px (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 320, height: 640 });
    await connectDemo(page);
    await page.getByRole('button', { name: 'Pay from pasted text' }).click();
    const sheet = page.getByRole('dialog', { name: 'Pay from pasted text' });
    await sheet
      .getByLabel('Invoice or message')
      .fill('ТОВ "Ромашка"\nUA213223130000026007233566002');
    await expect(sheet.getByText('its check digits do not match')).toBeVisible();
    await expectNoViolations(page);
    await sheet.getByLabel('Invoice or message').fill(INVOICE);
    await expect(sheet.getByRole('img')).toBeVisible();
    await expectNoViolations(page);
    await expectNothingPastTheEdge(page);
    await sheet.getByLabel('Invoice or message').fill('4111 1111 1111 1112 500 грн');
    await expect(sheet.getByText('its check digit does not match')).toBeVisible();
    await expectNoViolations(page);
    await sheet.getByLabel('Invoice or message').fill('4111 1111 1111 1111 500 грн');
    await expect(sheet.getByRole('link', { name: 'Open in Privat24' })).toBeVisible();
    await expectNoViolations(page);
    await expectNothingPastTheEdge(page);
  });
}
