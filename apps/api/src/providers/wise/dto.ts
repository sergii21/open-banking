import * as z from 'zod';

/**
 * Wise's public API, read for balances only (docs.wise.com, version 2026Q4): `GET /profiles` and
 * `GET /profiles/{profileId}/balances?types=STANDARD,SAVINGS`. Amounts are JSON numbers; the adapter re-reads the answer so
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

/**
 * JSON.parse that keeps every `value` number as the text it was written with ("2500.10", not 2500.1), through the reviver's
 * source-text access (Node 22 and later). Money is then read with integer arithmetic only.
 */
export function parseKeepingAmounts(raw: string): unknown {
  const reviver = ((key: string, value: unknown, context?: { source?: string }): unknown =>
    key === 'value' && typeof value === 'number' && context?.source !== undefined
      ? context.source
      : value) as unknown as Parameters<typeof JSON.parse>[1];
  return JSON.parse(raw, reviver);
}
