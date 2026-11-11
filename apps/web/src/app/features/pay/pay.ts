import {
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import {
  formatCardNumber,
  formatMoney,
  isValidCardNumber,
  minorToDecimalString,
  nbuPaymentLink,
  parseAmountToMinor,
  parseCardText,
  parsePaymentText,
  paymentProblems,
  PAYMENT_LIMITS,
  type PaymentDetails,
} from '@ledger-lens/contracts';
import { Toast } from '../../core/toast';
import { Ui } from '../../core/ui';
import { Clipboard } from '../../shared/copy';
import { qrBadgeDiameter, qrCode, qrPath } from '../../shared/qr';
import { Sheet } from '../../shared/sheet';

/**
 * Pay from pasted text: an invoice or a message goes in, the payment details come out as a National Bank of Ukraine payment code
 * and link. The person scans it with their bank's app and confirms there. Everything happens in this tab: the text is not sent
 * to the server, not stored, and the app moves no money. Loaded when first opened.
 */
@Component({
  selector: 'll-pay',
  imports: [Sheet],
  templateUrl: './pay.html',
})
export class Pay {
  protected readonly ui = inject(Ui);
  private readonly toast = inject(Toast);
  private readonly clipboard = inject(Clipboard);
  private readonly textBox = viewChild<ElementRef<HTMLTextAreaElement>>('textBox');

  protected readonly limits = PAYMENT_LIMITS;
  protected readonly text = signal('');
  protected readonly recipient = signal('');
  protected readonly iban = signal('');
  protected readonly code = signal('');
  protected readonly amount = signal('');
  protected readonly purpose = signal('');
  /** A card number found in the text. There is no payment code for a card: the person copies it and the amount to their bank. */
  private readonly card = signal('');
  /** The text names a card and no account: the account fields would only be in the way. */
  protected readonly cardMode = computed(() => this.card() !== '' && this.iban() === '');
  protected readonly cardText = computed(() => formatCardNumber(this.card()));
  protected readonly cardProblem = computed(() =>
    isValidCardNumber(this.card())
      ? null
      : 'This card number has a mistake in it: its check digit does not match.',
  );

  private readonly amountMinor = computed(() => parseAmountToMinor(this.amount(), 'UAH'));
  protected readonly amountProblem = computed(() => {
    if (this.amount().trim() === '') return null;
    const minor = this.amountMinor();
    return minor === null || minor > PAYMENT_LIMITS.amountMinor
      ? 'An amount in hryvnias, like 1500 or 1500,50. Leave it empty to type it in the bank app.'
      : null;
  });
  private readonly details = computed<PaymentDetails>(() => ({
    recipient: this.recipient(),
    iban: this.iban(),
    code: this.code(),
    amountMinor: this.amountMinor(),
    purpose: this.purpose(),
  }));
  /** Nothing is called wrong before the person has given the form anything. */
  protected readonly started = computed(() =>
    [this.recipient(), this.iban(), this.code(), this.amount(), this.purpose()].some(
      (value) => value.trim() !== '',
    ),
  );
  protected readonly problems = computed(() =>
    this.started() && !this.cardMode() ? paymentProblems(this.details()) : {},
  );
  private readonly made = computed(() =>
    this.amountProblem() || this.cardMode() ? null : nbuPaymentLink(this.details()),
  );
  protected readonly link = computed(() => {
    const made = this.made();
    return made?.ok ? made.link : null;
  });
  protected readonly tooLong = computed(() => {
    const made = this.made();
    return made !== null && !made.ok && made.reason === 'too-long';
  });
  protected readonly qr = computed(() => {
    const link = this.link();
    const code = link ? qrCode(link) : null;
    return code
      ? { size: code.size, path: qrPath(code), badge: qrBadgeDiameter(code.version) / 2 }
      : null;
  });
  protected readonly summary = computed(() => {
    const minor = this.amountMinor();
    const amount =
      minor === null ? 'the amount is typed in the bank app' : formatMoney(minor, 'UAH');
    return `Payment code: ${this.recipient().trim()}, ${amount}`;
  });

  constructor() {
    // Opening starts clean: the last invoice is not kept anywhere.
    effect(() => {
      if (!this.ui.payText()) return;
      untracked(() => this.read(''));
    });
  }

  /** The pasted text is the source: reading it again replaces what the fields held. */
  protected read(text: string): void {
    this.text.set(text);
    const found = parsePaymentText(text);
    const card = parseCardText(text);
    this.card.set(card.card);
    if (found.iban === '' && card.card !== '') found.amountMinor = card.amountMinor;
    this.recipient.set(found.recipient);
    this.iban.set(found.iban);
    this.code.set(found.code);
    this.amount.set(
      found.amountMinor === null
        ? ''
        : minorToDecimalString(found.amountMinor, 'UAH').replace('.', ','),
    );
    this.purpose.set(found.purpose);
  }

  protected setIban(typed: string): void {
    this.iban.set(typed.replace(/\s/g, '').toUpperCase());
  }

  protected async paste(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      if (text.trim() === '') this.toast.show('The clipboard has no text in it');
      else this.read(text);
    } catch {
      this.toast.show(
        'The browser did not allow reading the clipboard. Paste into the box instead',
      );
      this.textBox()?.nativeElement.focus();
    }
  }

  protected copyCard(): void {
    void this.clipboard.copy(this.card(), 'Card number');
  }

  protected copyAmount(): void {
    void this.clipboard.copy(this.amount().trim(), 'Amount');
  }

  protected copyLink(): void {
    const link = this.link();
    if (link) void this.clipboard.copy(link, 'Payment link');
  }
}
