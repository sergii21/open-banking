import * as z from 'zod';
import { Currency, Id, IsoDateTime, Money, ProviderId, ProviderMode } from './common';
import { isValidIban } from './iban';

/** Sandbox providers cap payments at 5,000,000 minor units (50,000.00). */
export const MAX_PAYMENT_MINOR = 5_000_000;

export const PaymentStatus = z.enum([
  'pending',
  'authorised',
  'executed',
  'settled',
  'failed',
  'cancelled',
]);
export type PaymentStatus = z.infer<typeof PaymentStatus>;

export const PaymentFailureReason = z.enum([
  'authorisation_failed',
  'execution_rejected',
  'insufficient_funds',
  'cancelled',
  'expired',
  'provider_error',
]);
export type PaymentFailureReason = z.infer<typeof PaymentFailureReason>;

export const PayeeName = z.string().trim().min(1, 'Enter the payee name').max(100);
export const IbanInput = z.string().refine(isValidIban, 'Enter a valid IBAN');
export const SortCodeInput = z.string().regex(/^\d{6}$/, 'Sort code is 6 digits');
export const AccountNumberInput = z.string().regex(/^\d{8}$/, 'Account number is 8 digits');

export const BeneficiaryInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('iban'), name: PayeeName, iban: IbanInput }),
  z.object({
    type: z.literal('sort_code_account_number'),
    name: PayeeName,
    sortCode: SortCodeInput,
    accountNumber: AccountNumberInput,
  }),
]);
export type BeneficiaryInput = z.infer<typeof BeneficiaryInput>;

export const PaymentReference = z
  .string()
  .trim()
  .min(1, 'Add a reference')
  .max(18, 'At most 18 characters')
  .regex(/^[A-Za-z0-9 .\-/]+$/, 'Letters, digits, space . - / only');

export const CreatePaymentRequest = z.object({
  institutionId: z.string().min(1),
  amountMinor: z.number().int().positive().max(MAX_PAYMENT_MINOR),
  currency: Currency,
  /** Omitted when the institution pays a fixed account (`Institution.fixedPayee`). */
  beneficiary: BeneficiaryInput.optional(),
  reference: PaymentReference,
});
export type CreatePaymentRequest = z.infer<typeof CreatePaymentRequest>;

/** `Idempotency-Key` request header on `POST /api/payments`: one fresh value (a UUID) per payment attempt. */
export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const IdempotencyKey = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/, 'The Idempotency-Key must be 8-64 letters, digits, "-" or "_"');

/** What `POST /api/webhooks/:provider` answers. Anything 2xx tells the provider to stop retrying. */
export const WebhookAck = z.object({
  status: z.enum(['applied', 'ignored', 'duplicate', 'unknown_payment', 'unsupported_event']),
});
export type WebhookAck = z.infer<typeof WebhookAck>;

export const PaymentHistoryEntry = z.object({
  status: PaymentStatus,
  at: IsoDateTime,
  note: z.string().nullable(),
});
export type PaymentHistoryEntry = z.infer<typeof PaymentHistoryEntry>;

export const Payment = z.object({
  id: Id,
  provider: ProviderId,
  mode: ProviderMode,
  institutionId: z.string(),
  institutionName: z.string(),
  amount: Money,
  beneficiaryName: z.string(),
  /** Masked IBAN or account number; the full identifier is stored server-side only. */
  beneficiaryIdentifier: z.string(),
  reference: z.string(),
  status: PaymentStatus,
  /**
   * Whether a `settled` step will follow `executed`. Pay-ins to a merchant account settle; payments to an
   * external account end at `executed` (the bank accepted it), so the timeline must not wait for a step that never comes.
   */
  settlementExpected: z.boolean(),
  failureReason: PaymentFailureReason.nullable(),
  statusHistory: z.array(PaymentHistoryEntry),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Present only while the payment still waits for approval at the bank (the "resume" link). */
  authUrl: z.string().nullable(),
});
export type Payment = z.infer<typeof Payment>;

export const PaymentList = z.object({ items: z.array(Payment) });
export type PaymentList = z.infer<typeof PaymentList>;

export const TERMINAL_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  'settled',
  'failed',
  'cancelled',
];
