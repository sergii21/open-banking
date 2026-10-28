import * as z from 'zod';

/**
 * monobank's personal API, as documented at https://api.monobank.ua/docs/. Amounts are integers in minor units
 * (kopiykas, cents), times are Unix seconds, currencies are ISO 4217 numeric codes.
 */
export const ClientInfoDto = z.object({
  clientId: z.string(),
  name: z.string().nullish(),
  permissions: z.string().nullish(),
  accounts: z.array(
    z.object({
      id: z.string(),
      sendId: z.string().nullish(),
      /** Own funds plus the credit limit, i.e. what can be spent right now. */
      balance: z.number().int(),
      creditLimit: z.number().int().nullish(),
      type: z.string(),
      currencyCode: z.number().int(),
      cashbackType: z.string().nullish(),
      maskedPan: z.array(z.string()).nullish(),
      iban: z.string().nullish(),
    }),
  ),
  jars: z
    .array(
      z.object({
        id: z.string(),
        sendId: z.string().nullish(),
        title: z.string(),
        description: z.string().nullish(),
        currencyCode: z.number().int(),
        balance: z.number().int(),
        goal: z.number().int().nullish(),
      }),
    )
    .nullish(),
});
export type ClientInfo = z.infer<typeof ClientInfoDto>;

export const StatementDto = z.array(
  z.object({
    id: z.string(),
    time: z.number().int(),
    description: z.string().nullish(),
    mcc: z.number().int().nullish(),
    originalMcc: z.number().int().nullish(),
    /** True while the amount is only reserved (a card authorisation that has not booked yet). */
    hold: z.boolean().nullish(),
    /** In the account's currency. */
    amount: z.number().int(),
    /** In the currency of the operation, which monobank does not name. */
    operationAmount: z.number().int().nullish(),
    currencyCode: z.number().int(),
    commissionRate: z.number().int().nullish(),
    cashbackAmount: z.number().int().nullish(),
    balance: z.number().int().nullish(),
    comment: z.string().nullish(),
    receiptId: z.string().nullish(),
    invoiceId: z.string().nullish(),
    counterEdrpou: z.string().nullish(),
    counterIban: z.string().nullish(),
    counterName: z.string().nullish(),
  }),
);
export type StatementItem = z.infer<typeof StatementDto>[number];
