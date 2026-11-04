import * as z from 'zod';

/**
 * Wise's public API (docs.wise.com, version 2026Q4): balances (`GET /profiles`, `GET /profiles/{profileId}/balances`), and what a
 * draft transfer needs (recipients, a quote, the unpaid transfer). Amounts are JSON numbers; the adapter re-reads the answer so
 * each one arrives as the text Wise wrote (see `parseKeepingAmounts`), and no float is ever turned into money. Parsing is
 * tolerant like the other adapters: unknown fields are ignored, one row that cannot be read never hides the others.
 */
const text = z.string().nullish();
const amountText = z.union([z.string().min(1), z.number()]).transform(String);

export const PROFILE_FIELDS = new Set([
  'type',
  'id',
  'publicId',
  'userId',
  'address',
  'email',
  'createdAt',
  'updatedAt',
  'avatar',
  'currentState',
  'contactDetails',
  'firstName',
  'lastName',
  'preferredName',
  'dateOfBirth',
  'phoneNumber',
  'secondaryAddresses',
  'fullName',
  'businessName',
  'registrationNumber',
  'descriptionOfBusiness',
  'industryCategories',
  'companyType',
  'companyRole',
  'businessCategory',
  'businessSubCategory',
  'webpage',
]);

export const BALANCE_FIELDS = new Set([
  'id',
  'currency',
  'type',
  'name',
  'icon',
  'investmentState',
  'amount',
  'reservedAmount',
  'cashAmount',
  'totalWorth',
  'creationTime',
  'modificationTime',
  'visible',
  'primary',
]);

export const RECIPIENT_FIELDS = new Set([
  'id',
  'creatorId',
  'profileId',
  'profile',
  'user',
  'name',
  'accountHolderName',
  'currency',
  'country',
  'type',
  'details',
  'legalEntityType',
  'active',
  'commonFieldMap',
  'hash',
  'accountSummary',
  'longAccountSummary',
  'displayFields',
  'isInternal',
  'ownedByCustomer',
  'email',
  'business',
  'confirmations',
]);

export const QUOTE_FIELDS = new Set([
  'id',
  'sourceCurrency',
  'targetCurrency',
  'sourceAmount',
  'targetAmount',
  'targetAccount',
  'payOut',
  'preferredPayIn',
  'rate',
  'rateType',
  'createdTime',
  'expirationTime',
  'user',
  'profile',
  'paymentOptions',
  'notices',
  'status',
  'clientId',
  'pricingConfiguration',
  'pricingScheme',
  'guaranteedTargetAmountAllowed',
  'targetAmountAllowed',
  'funding',
  'providedAmountType',
  'rateExpirationTime',
  'transferFlowConfig',
  'type',
]);

export const TRANSFER_FIELDS = new Set([
  'id',
  'user',
  'business',
  'targetAccount',
  'sourceAccount',
  'quote',
  'quoteUuid',
  'status',
  'reference',
  'rate',
  'created',
  'transferRequest',
  'details',
  'hasActiveIssues',
  'sourceCurrency',
  'sourceValue',
  'targetCurrency',
  'targetValue',
  'customerTransactionId',
  'originalTransferId',
  'payinSessionId',
  'originator',
]);

export const ProfileDto = z.object({
  id: z.number().int(),
  type: z.string(),
  currentState: text,
});
export type ProfileItem = z.infer<typeof ProfileDto>;

const Amount = z.object({ value: amountText, currency: z.string().regex(/^[A-Za-z]{3}$/) });

export const BalanceDto = z.object({
  id: z.number().int(),
  currency: z.string().regex(/^[A-Za-z]{3}$/),
  type: text,
  name: text,
  visible: z.boolean().nullish(),
  amount: Amount,
});
export type BalanceItem = z.infer<typeof BalanceDto>;

export const RecipientDto = z.object({
  id: z.number().int(),
  name: z.object({ fullName: text }).nullish(),
  accountHolderName: text,
  currency: z.string().regex(/^[A-Za-z]{3}$/),
  active: z.boolean().nullish(),
  accountSummary: text,
});
export type RecipientItem = z.infer<typeof RecipientDto>;

const PaymentOption = z.object({
  payIn: text,
  payOut: text,
  sourceAmount: amountText,
  targetAmount: amountText,
  disabled: z.boolean().nullish(),
  disabledReason: z.object({ message: text }).nullish(),
  fee: z.object({ total: amountText.nullish() }).nullish(),
  price: z
    .object({
      total: z.object({ value: z.object({ amount: amountText, currency: text }) }),
    })
    .nullish(),
});

export const QuoteDto = z.object({
  id: z.string().min(1),
  sourceCurrency: z.string().regex(/^[A-Za-z]{3}$/),
  targetCurrency: z.string().regex(/^[A-Za-z]{3}$/),
  payOut: text,
  rate: amountText.nullish(),
  expirationTime: text,
  paymentOptions: z.array(PaymentOption),
});
export type QuoteItem = z.infer<typeof QuoteDto>;

export const TransferDto = z.object({
  id: z.number().int(),
  status: z.string(),
  created: text,
  targetAccount: z.number().int().nullish(),
  targetCurrency: z.string().regex(/^[A-Za-z]{3}$/),
  targetValue: amountText,
});
export type TransferItem = z.infer<typeof TransferDto>;

export const CreatedTransferDto = z.object({ id: z.number().int(), status: z.string() });

/** Wise's amounts are JSON numbers under these keys. */
const AMOUNT_KEYS = new Set([
  'value',
  'amount',
  'total',
  'sourceAmount',
  'targetAmount',
  'sourceValue',
  'targetValue',
  'rate',
]);

/**
 * JSON.parse that keeps every amount as the text it was written with ("2500.10", not 2500.1), through the reviver's
 * source-text access (Node 22 and later). Money is then read with integer arithmetic only.
 */
export function parseKeepingAmounts(raw: string): unknown {
  const reviver = ((key: string, value: unknown, context?: { source?: string }): unknown =>
    AMOUNT_KEYS.has(key) && typeof value === 'number' && context?.source !== undefined
      ? context.source
      : value) as unknown as Parameters<typeof JSON.parse>[1];
  return JSON.parse(raw, reviver);
}
