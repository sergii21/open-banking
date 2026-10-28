import { z } from 'zod';
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

const PayeeName = z.string().trim().min(1, 'Enter the payee name').max(100);

export const BeneficiaryInput = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('iban'),
    name: PayeeName,
    iban: z.string().refine(isValidIban, 'Enter a valid IBAN'),
  }),
  z.object({
    type: z.literal('sort_code_account_number'),
    name: PayeeName,
    sortCode: z.string().regex(/^\d{6}$/, 'Sort code is 6 digits'),
    accountNumber: z.string().regex(/^\d{8}$/, 'Account number is 8 digits'),
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
  beneficiary: BeneficiaryInput,
  reference: PaymentReference,
});
export type CreatePaymentRequest = z.infer<typeof CreatePaymentRequest>;

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
