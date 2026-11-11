import {
  PAYMENT_LIMITS,
  formatCardNumber,
  formatMoney,
  isValidCardNumber,
  minorToDecimalString,
  nbuPaymentLink,
  parseAmountToMinor,
  parseCardText,
  parsePaymentText,
  paymentProblems,
  privat24CardLink,
  type PaymentField,
} from '@ledger-lens/contracts';
import { qrBadgeDiameter, qrCode, qrPath } from '@web-shared/qr';

/** What the person sees and can type over. The amount is text here and integer kopiykas the moment it is used. */
export interface PayForm {
  kind: 'account' | 'card';
  recipient: string;
  iban: string;
  code: string;
  amount: string;
  purpose: string;
  /** Digits only. */
  card: string;
}

export const EMPTY_PAY_FORM: PayForm = {
  kind: 'account',
  recipient: '',
  iban: '',
  code: '',
  amount: '',
  purpose: '',
  card: '',
};

/** Reads pasted text into the form: an IBAN makes it a payment to an account, a card number alone a transfer to a card. */
export function readPayText(text: string): PayForm {
  const found = parsePaymentText(text);
  const card = parseCardText(text);
  const toCard = found.iban === '' && card.card !== '';
  const amountMinor = toCard ? card.amountMinor : found.amountMinor;
  return {
    kind: toCard ? 'card' : 'account',
    recipient: found.recipient,
    iban: found.iban,
    code: found.code,
    amount: amountMinor === null ? '' : minorToDecimalString(amountMinor, 'UAH').replace('.', ','),
    purpose: found.purpose,
    card: card.card,
  };
}

export interface PayView {
  /** Nothing is called wrong before the person has given the form anything. */
  started: boolean;
  problems: Partial<Record<PaymentField, string>>;
  amountProblem: string | null;
  cardProblem: string | null;
  cardText: string;
  /** The National Bank's payment link, once every field is right. Opening it hands the payment to a bank app. */
  link: string | null;
  tooLong: boolean;
  qr: { size: number; path: string; badgeRadius: number } | null;
  /** Privat24's transfer form with the card and the amount filled in: an address PrivatBank does not document. */
  privatLink: string | null;
  summary: string;
}

/** Everything the Pay screen shows, worked out from the form. No network, no storage: the app moves no money. */
export function payView(form: PayForm): PayView {
  const cardMode = form.kind === 'card';
  const started = [form.recipient, form.iban, form.code, form.amount, form.purpose, form.card].some(
    (value) => value.trim() !== '',
  );
  const amountMinor = parseAmountToMinor(form.amount, 'UAH');
  const amountProblem =
    form.amount.trim() !== '' && (amountMinor === null || amountMinor > PAYMENT_LIMITS.amountMinor)
      ? 'An amount in hryvnias, like 1500 or 1500,50. Leave it empty to type it in the bank app.'
      : null;

  let cardProblem: string | null = null;
  if (form.card === '') cardProblem = started ? 'The card number is 16 digits.' : null;
  else if (form.card.length < 16) cardProblem = 'The card number is 16 digits.';
  else if (!isValidCardNumber(form.card)) {
    cardProblem = 'This card number has a mistake in it: its check digit does not match.';
  }

  const details = {
    recipient: form.recipient,
    iban: form.iban,
    code: form.code,
    amountMinor,
    purpose: form.purpose,
  };
  const made = amountProblem || cardMode ? null : nbuPaymentLink(details);
  const link = made?.ok ? made.link : null;
  const code = link ? qrCode(link) : null;

  return {
    started,
    problems: started && !cardMode ? paymentProblems(details) : {},
    amountProblem,
    cardProblem,
    cardText: formatCardNumber(form.card),
    link,
    tooLong: made !== null && !made.ok && made.reason === 'too-long',
    qr: code
      ? { size: code.size, path: qrPath(code), badgeRadius: qrBadgeDiameter(code.version) / 2 }
      : null,
    privatLink:
      cardMode && !amountProblem && cardProblem === null && form.card !== ''
        ? privat24CardLink({ card: form.card, amountMinor })
        : null,
    summary: `Payment code: ${form.recipient.trim()}, ${
      amountMinor === null ? 'the amount is typed in the bank app' : formatMoney(amountMinor, 'UAH')
    }`,
  };
}
