import * as z from 'zod';

/**
 * monobank's personal API as documented at https://api.monobank.ua/docs/ (spec v250818). Amounts are integers in minor
 * units, times are Unix seconds, currencies are ISO 4217 numeric codes.
 *
 * Parsing is deliberately tolerant: unknown fields are ignored, everything but the identifying core is optional, numbers
 * may arrive as numeric strings, and one row that cannot be read never hides the others (see `parseRows`).
 */
const int = z.preprocess(
  (value) => (typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value) : value),
  z
    .number()
    .finite()
    .transform((n) => Math.round(n)),
);
const text = z.string().nullish();

export const CLIENT_ACCOUNT_FIELDS = new Set([
  'id',
  'sendId',
  'balance',
  'creditLimit',
  'type',
  'currencyCode',
  'cashbackType',
  'maskedPan',
  'iban',
]);
export const CLIENT_JAR_FIELDS = new Set([
  'id',
  'sendId',
  'title',
  'description',
  'currencyCode',
  'balance',
  'goal',
]);
export const STATEMENT_FIELDS = new Set([
  'id',
  'time',
  'description',
  'mcc',
  'originalMcc',
  'hold',
  'amount',
  'operationAmount',
  'currencyCode',
  'commissionRate',
  'cashbackAmount',
  'balance',
  'comment',
  'receiptId',
  'invoiceId',
  'counterEdrpou',
  'counterIban',
  'counterName',
]);

export const AccountDto = z.object({
  id: z.string().min(1),
  balance: int,
  currencyCode: int,
  creditLimit: int.nullish(),
  type: text,
  maskedPan: z.array(z.string()).nullish(),
  iban: text,
});
export type AccountItem = z.infer<typeof AccountDto>;

export const JarDto = z.object({
  id: z.string().min(1),
  title: text,
  currencyCode: int,
  balance: int,
  goal: int.nullish(),
});
export type JarItem = z.infer<typeof JarDto>;

export const StatementItemDto = z.object({
  id: z.string().min(1),
  time: int,
  amount: int,
  currencyCode: int,
  description: text,
  mcc: int.nullish(),
  hold: z.boolean().nullish(),
  commissionRate: int.nullish(),
  cashbackAmount: int.nullish(),
  balance: int.nullish(),
  comment: text,
  receiptId: text,
  counterName: text,
});
export type StatementItem = z.infer<typeof StatementItemDto>;

export const RateDto = z.object({
  currencyCodeA: int,
  currencyCodeB: int,
  date: int.nullish(),
  rateBuy: z.number().nullish(),
  rateSell: z.number().nullish(),
  rateCross: z.number().nullish(),
});

/** Field paths and issue codes only: a message built here can go into the diagnostics, which never hold data. */
export function issueSummary(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.map(String).join('.') || '(row)'}: ${issue.code}`)
    .join('; ');
}

/** Parses each row on its own. Returns what could be read and, for what could not, a summary per failed row. */
export function parseRows<T>(
  schema: z.ZodType<T>,
  rows: readonly unknown[],
): { items: T[]; failures: string[] } {
  const items: T[] = [];
  const failures: string[] = [];
  for (const row of rows) {
    const result = schema.safeParse(row);
    if (result.success) items.push(result.data);
    else failures.push(issueSummary(result.error));
  }
  return { items, failures };
}
