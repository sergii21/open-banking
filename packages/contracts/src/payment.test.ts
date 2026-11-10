import { describe, expect, it } from 'vitest';
import {
  NBU_LINK_BASE,
  isValidUaIban,
  nbuPaymentFields,
  nbuPaymentLink,
  parsePaymentText,
  paymentProblems,
  type PaymentDetails,
} from './payment';

/** Made up, with correct check digits: not anybody's account. */
const IBAN = 'UA213223130000026007233566001';

const details: PaymentDetails = {
  recipient: 'ФОП Шевченко Тарас Григорович',
  iban: IBAN,
  code: '1234567890',
  amountMinor: 150_000,
  purpose: 'Оплата за послуги згідно рахунку № 15',
};

const decode = (link: string): string =>
  Buffer.from(link.slice(NBU_LINK_BASE.length), 'base64url').toString('utf8');

describe('isValidUaIban', () => {
  it('checks the shape and the check digits', () => {
    expect(isValidUaIban(IBAN)).toBe(true);
    expect(isValidUaIban('UA213223130000026007233566002')).toBe(false);
    expect(isValidUaIban('UA21322313000002600723356600')).toBe(false);
    expect(isValidUaIban('DE89370400440532013000')).toBe(false);
  });
});

describe('parsePaymentText', () => {
  it('reads a labelled invoice block', () => {
    const text = [
      'Рахунок на оплату № 15 від 10.11.2026',
      'Отримувач: ФОП Шевченко Тарас Григорович',
      'IBAN: UA21 3223 1300 0002 6007 2335 6600 1',
      'ІПН 1234567890',
      'Банк: АТ «УКРСИББАНК», МФО 351005',
      'Призначення платежу: Оплата за послуги згідно рахунку № 15',
      'Всього до сплати: 1 500,00 грн',
    ].join('\n');
    expect(parsePaymentText(text)).toEqual(details);
  });

  it('reads a short chat message with no labels', () => {
    const text = `ТОВ "Ромашка"\n${IBAN}\n12345678\n250 грн`;
    expect(parsePaymentText(text)).toEqual({
      recipient: 'ТОВ "Ромашка"',
      iban: IBAN,
      code: '12345678',
      amountMinor: 25_000,
      purpose: '',
    });
  });

  it('never reads a code or an amount out of the account number', () => {
    const found = parsePaymentText(`рахунок ${IBAN} uah`);
    expect(found).toEqual({ recipient: '', iban: IBAN, code: '', amountMinor: null, purpose: '' });
  });

  it('keeps an account number with a mistake, so the person sees it and is told', () => {
    const found = parsePaymentText('UA213223130000026007233566002');
    expect(found.iban).toBe('UA213223130000026007233566002');
    expect(paymentProblems(found).iban).toMatch(/check digits/);
  });

  it('finds nothing in text that has no payment in it', () => {
    expect(parsePaymentText('Привіт! Як справи? Подзвони на 0671234567')).toEqual({
      recipient: '',
      iban: '',
      code: '',
      amountMinor: null,
      purpose: '',
    });
  });
});

describe('the NBU payment link', () => {
  it('has the 17 fields of format 003 in order', () => {
    expect(nbuPaymentFields(details)).toEqual([
      'BCD',
      '003',
      '1',
      'UCT',
      '',
      'ФОП Шевченко Тарас Григорович',
      IBAN,
      'UAH1500.00',
      '1234567890',
      'OTHR/OTHR',
      '',
      'Оплата за послуги згідно рахунку № 15',
      '',
      '',
      '',
      '',
      '',
    ]);
  });

  it('is the fields, line by line, as unpadded Base64URL after the National Bank’s address', () => {
    const made = nbuPaymentLink(details);
    if (!made.ok) throw new Error(made.reason);
    expect(made.link).toMatch(/^https:\/\/qr\.bank\.gov\.ua\/[A-Za-z0-9_-]+$/);
    expect(decode(made.link)).toBe(nbuPaymentFields(details).join('\n'));
  });

  it('leaves the amount to the person when there is none', () => {
    expect(nbuPaymentFields({ ...details, amountMinor: null })[7]).toBe('');
    expect(nbuPaymentFields({ ...details, amountMinor: 5 })[7]).toBe('UAH0.05');
  });

  it('keeps a line break in a value from moving the fields after it', () => {
    const fields = nbuPaymentFields({ ...details, purpose: 'за послуги\nлистопад' });
    expect(fields).toHaveLength(17);
    expect(fields[11]).toBe('за послуги листопад');
  });

  it('is refused while something is missing, and when it would not fit a code', () => {
    expect(nbuPaymentLink({ ...details, code: '123' })).toEqual({
      ok: false,
      reason: 'incomplete',
    });
    expect(nbuPaymentLink({ ...details, purpose: ' ' })).toEqual({
      ok: false,
      reason: 'incomplete',
    });
    expect(nbuPaymentLink({ ...details, purpose: 'щ'.repeat(400) })).toEqual({
      ok: false,
      reason: 'too-long',
    });
  });
});
