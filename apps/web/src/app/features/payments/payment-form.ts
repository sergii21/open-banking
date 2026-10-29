import { DOCUMENT } from '@angular/common';
import { httpResource } from '@angular/common/http';
import { Component, computed, inject, input, linkedSignal, signal } from '@angular/core';
import {
  form,
  FormField,
  FormRoot,
  hidden,
  maxLength,
  validate,
  validateStandardSchema,
} from '@angular/forms/signals';
import { MatButton } from '@angular/material/button';
import { MatFormField, MatHint, MatLabel, MatError, MatSuffix } from '@angular/material/form-field';
import { MatIcon } from '@angular/material/icon';
import { MatInput } from '@angular/material/input';
import { MatOption, MatSelect } from '@angular/material/select';
import { Router, RouterLink } from '@angular/router';
import {
  AccountNumberInput,
  CreatePaymentRequest,
  IbanInput,
  InstitutionList,
  PayeeName,
  PaymentReference,
  SortCodeInput,
  toMinorUnits,
  type BeneficiaryInput,
  type Institution,
} from '@ledger-lens/contracts';
import { describeError, toApiError, type ApiError } from '../../core/api/api-error';
import { SessionService } from '../../core/session/session';
import { formatMoney } from '../../shared/format';
import { Skeleton } from '../../shared/states/skeleton';
import { StateCard } from '../../shared/states/state-card';
import { StatusChip } from '../../shared/status-chip/status-chip';
import { newIdempotencyKey, PaymentsData } from './payments-data';

interface PaymentFormModel {
  institutionId: string;
  currency: string;
  amount: string;
  reference: string;
  payeeName: string;
  iban: string;
  sortCode: string;
  accountNumber: string;
}

/** Outcomes where the bank may or may not have the payment: the same Idempotency-Key must be used to try again. */
const UNKNOWN_OUTCOME = new Set([
  'bank_unavailable',
  'network',
  'unknown',
  'conflict',
  'provider_error',
]);

/**
 * Send money. The form validates with the same Zod schemas the API enforces (so the two cannot disagree), and every
 * attempt carries an Idempotency-Key: pressing the button twice, or retrying after a timeout, can never pay twice.
 */
@Component({
  selector: 'll-payment-form',
  imports: [
    FormField,
    FormRoot,
    MatButton,
    MatError,
    MatFormField,
    MatHint,
    MatIcon,
    MatInput,
    MatLabel,
    MatOption,
    MatSelect,
    MatSuffix,
    RouterLink,
    Skeleton,
    StateCard,
    StatusChip,
  ],
  templateUrl: './payment-form.html',
})
export class PaymentForm {
  private readonly data = inject(PaymentsData);
  private readonly session = inject(SessionService);
  private readonly document = inject(DOCUMENT);
  private readonly router = inject(Router);

  // Pre-filled from the query string when someone starts again after a failed payment.
  readonly institution = input<string>();
  readonly currency = input<string>();
  readonly amount = input<string>();
  readonly reference = input<string>();

  protected readonly institutions = httpResource<Institution[]>(() => '/api/institutions', {
    defaultValue: [],
    parse: (raw) => InstitutionList.parse(raw).items,
  });

  /** Banks that can take a payment. A degraded one stays listed: choosing it is how the "bank is down" case is shown. */
  protected readonly banks = computed(() =>
    this.institutions.value().filter((bank) => bank.capabilities.payments),
  );

  protected readonly model = linkedSignal<PaymentFormModel>(() => {
    const banks = this.banks();
    const chosen = banks.find((bank) => bank.id === this.institution()) ?? banks[0];
    const wanted = this.currency();
    return {
      institutionId: chosen?.id ?? '',
      currency:
        chosen && wanted && chosen.currencies.includes(wanted)
          ? wanted
          : (chosen?.currencies[0] ?? ''),
      amount: this.amount() ?? '',
      reference: this.reference() ?? '',
      payeeName: '',
      iban: '',
      sortCode: '',
      accountNumber: '',
    };
  });

  protected readonly bank = computed(() =>
    this.banks().find((candidate) => candidate.id === this.model().institutionId),
  );
  /** The customer names the payee unless the bank pays one fixed account. */
  protected readonly needsPayee = computed(() => (this.bank() ? !this.bank()?.fixedPayee : false));
  protected readonly isEuro = computed(() => this.model().currency === 'EUR');
  protected readonly isSterling = computed(() => this.model().currency === 'GBP');

  protected readonly serverError = linkedSignal<ApiError | null>(() => {
    this.model();
    return null;
  });

  private attempt: { fingerprint: string; key: string; unknownOutcome: boolean } | null = null;
  /** The last try ended without knowing whether the bank got the payment, so pressing the button again reuses its key. */
  private readonly keyReusable = signal(false);

  protected readonly payment = form<PaymentFormModel>(
    this.model,
    (path) => {
      validate(path.institutionId, ({ value }) =>
        value() ? null : { kind: 'required', message: 'Choose a bank' },
      );
      validateStandardSchema(path.reference, PaymentReference);
      maxLength(path.reference, 18, { message: 'At most 18 characters' });

      validate(path.amount, ({ value }) => {
        const text = value().trim();
        if (!text) return { kind: 'required', message: 'Enter an amount' };
        const minor = toMinorUnits(text, this.model().currency || 'EUR');
        if (minor === null) return { kind: 'amount', message: 'Enter an amount such as 12.50' };
        const max = this.session.maxPaymentMinor();
        if (minor > max) {
          return {
            kind: 'max',
            message: `This demo allows at most ${formatMoney(max, this.model().currency || 'EUR')} per payment`,
          };
        }
        return null;
      });

      // The payee fields only exist when the customer chooses the payee, and only the ones the currency needs.
      hidden(path.payeeName, () => !this.needsPayee());
      hidden(path.iban, () => !this.needsPayee() || !this.isEuro());
      hidden(path.sortCode, () => !this.needsPayee() || !this.isSterling());
      hidden(path.accountNumber, () => !this.needsPayee() || !this.isSterling());
      validateStandardSchema(path.payeeName, PayeeName);
      validateStandardSchema(path.iban, IbanInput);
      validateStandardSchema(path.sortCode, SortCodeInput);
      validateStandardSchema(path.accountNumber, AccountNumberInput);
      maxLength(path.sortCode, 6, { message: 'Sort code is 6 digits' });
      maxLength(path.accountNumber, 8, { message: 'Account number is 8 digits' });
    },
    {
      submission: {
        action: async () => {
          const request = this.request();
          if (!request) return { kind: 'invalid', message: 'Check the details and try again.' };

          const fingerprint = JSON.stringify(request);
          // Only the very same request may reuse a key, and only when its outcome is unknown: that is the retry that
          // must not pay twice. A changed or definitively refused request is a new attempt.
          if (!(this.attempt?.fingerprint === fingerprint && this.attempt.unknownOutcome)) {
            this.attempt = { fingerprint, key: newIdempotencyKey(), unknownOutcome: false };
          }

          try {
            const created = await this.data.create(request, this.attempt.key);
            this.attempt = null;
            this.keyReusable.set(false);
            if (created.authUrl) {
              this.document.location.assign(created.authUrl);
            } else {
              await this.router.navigate(['/payments', created.id]);
            }
            return undefined;
          } catch (error) {
            const failure = toApiError(error);
            const reusable = UNKNOWN_OUTCOME.has(failure.code);
            if (this.attempt) this.attempt.unknownOutcome = reusable;
            this.keyReusable.set(reusable);
            this.serverError.set(failure);
            return undefined;
          }
        },
      },
    },
  );

  protected readonly failure = computed(() => {
    const error = this.serverError();
    return error ? describeError(error) : null;
  });
  protected readonly retrying = computed(() => this.keyReusable() && this.failure() !== null);

  protected readonly maxLabel = computed(() =>
    formatMoney(this.session.maxPaymentMinor(), this.model().currency || 'EUR'),
  );

  protected chooseBank(id: string): void {
    const bank = this.banks().find((candidate) => candidate.id === id);
    if (!bank) return;
    this.model.update((current) => ({
      ...current,
      currency: bank.currencies.includes(current.currency) ? current.currency : bank.currencies[0],
    }));
  }

  /** The request the API will see, or null if the form is not complete enough to build one. */
  private request(): CreatePaymentRequest | null {
    const m = this.model();
    const minor = toMinorUnits(m.amount, m.currency);
    if (minor === null || !this.bank()) return null;
    const beneficiary: BeneficiaryInput | undefined = !this.needsPayee()
      ? undefined
      : this.isSterling()
        ? {
            type: 'sort_code_account_number',
            name: m.payeeName.trim(),
            sortCode: m.sortCode.trim(),
            accountNumber: m.accountNumber.trim(),
          }
        : { type: 'iban', name: m.payeeName.trim(), iban: m.iban.trim() };
    const parsed = CreatePaymentRequest.safeParse({
      institutionId: m.institutionId,
      amountMinor: minor,
      currency: m.currency,
      ...(beneficiary ? { beneficiary } : {}),
      reference: m.reference.trim(),
    });
    return parsed.success ? parsed.data : null;
  }
}
