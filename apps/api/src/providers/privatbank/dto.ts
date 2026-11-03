import * as z from 'zod';

/**
 * PrivatBank "Autoclient" API v3.0.0, statements part (business and ФОП accounts; the personal-card API was closed in 2022).
 * Amounts are decimal strings, dates are `DD.MM.YYYY` with an optional `HH:MM:SS`, currencies are alphabetic ISO 4217.
 *
 * Parsing is deliberately tolerant, as for monobank: unknown fields are ignored, everything but the identifying core is
 * optional, and one row that cannot be read never hides the others (see `parseRows` in `../monobank/dto`). The field names
 * below are from the published document; what the real service sends beyond them is learned from `Copy diagnostics`.
 */
const text = z.string().nullish();
/** A decimal string such as "1234.50"; a bare number is accepted and read as its shortest decimal text. */
const amount = z.preprocess(
  (value) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : value),
  z.string().min(1),
);

export const SETTINGS_FIELDS = new Set([
  'phase',
  'dates_without_oper_day',
  'today',
  'lastday',
  'work_balance',
  'server_date_time',
  'date_final_statement',
]);

export const BALANCE_FIELDS = new Set([
  'acc',
  'currency',
  'balanceIn',
  'balanceInEq',
  'balanceOut',
  'balanceOutEq',
  'turnoverDebt',
  'turnoverDebtEq',
  'turnoverCred',
  'turnoverCredEq',
  'bgfIBrnm',
  'brnm',
  'dpd',
  'nameACC',
  'state',
  'atp',
  'flmn',
  'date_open_acc_reg',
  'date_open_acc_sys',
  'date_close_acc',
  'is_final_bal',
]);

export const TRANSACTION_FIELDS = new Set([
  'AUT_MY_CRF',
  'AUT_MY_MFO',
  'AUT_MY_ACC',
  'AUT_MY_NAM',
  'AUT_MY_MFO_NAME',
  'AUT_MY_MFO_CITY',
  'AUT_CNTR_CRF',
  'AUT_CNTR_MFO',
  'AUT_CNTR_ACC',
  'AUT_CNTR_NAM',
  'AUT_CNTR_MFO_NAME',
  'AUT_CNTR_MFO_CITY',
  'CCY',
  'FL_REAL',
  'PR_PR',
  'DOC_TYP',
  'NUM_DOC',
  'DAT_KL',
  'DAT_OD',
  'OSND',
  'SUM',
  'SUM_E',
  'REF',
  'REFN',
  'TIM_P',
  'DATE_TIME_DAT_OD_TIM_P',
  'ID',
  'TRANTYPE',
  'DLR',
  'TECHNICAL_TRANSACTION_ID',
  // Added "to meet the National Bank's requirements"; the *_ULTMT_* fields can hold a passport number.
  'UETR',
  'ULTMT',
  'PAYER_ULTMT_NCEO',
  'PAYER_ULTMT_DOCUMENT',
  'PAYER_ULTMT_NAME',
  'PAYER_ULTMT_COUNTRY_CODE',
  'RECIPIENT_ULTMT_NCEO',
  'RECIPIENT_ULTMT_DOCUMENT',
  'RECIPIENT_ULTMT_NAME',
  'RECIPIENT_ULTMT_COUNTRY_CODE',
  'STRUCT_CODE',
  'STRUCT_TYPE',
  'STRUCT_CATEGORY',
]);

export const SettingsDto = z.object({
  phase: text,
  work_balance: text,
  today: text,
  lastday: text,
});
export type Settings = z.infer<typeof SettingsDto>;

export const BalanceDto = z.object({
  acc: z.string().min(1),
  currency: z.string().regex(/^[A-Za-z]{3}$/),
  balanceOut: amount,
  date_close_acc: text,
});
export type BalanceItem = z.infer<typeof BalanceDto>;

export const TransactionDto = z.object({
  CCY: z.string().regex(/^[A-Za-z]{3}$/),
  SUM: amount,
  TRANTYPE: text,
  PR_PR: text,
  FL_REAL: text,
  REF: text,
  REFN: text,
  ID: text,
  TECHNICAL_TRANSACTION_ID: text,
  DAT_OD: text,
  DAT_KL: text,
  TIM_P: text,
  DATE_TIME_DAT_OD_TIM_P: text,
  OSND: text,
  AUT_CNTR_NAM: text,
});
export type TransactionItem = z.infer<typeof TransactionDto>;

/** `07.01.2020 02:58:00` or `07.01.2020` (and `02:58` as the separate time): a day and, when given, a wall-clock time. */
export function parseLocalDateTime(
  date: string | null | undefined,
  time?: string | null,
): { day: string; hour: number; minute: number; second: number } | null {
  const d = /(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(
    date ?? '',
  );
  if (!d) return null;
  const t = d[4] === undefined ? /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(time ?? '') : null;
  const month = Number(d[2]);
  const dom = Number(d[1]);
  if (month < 1 || month > 12 || dom < 1 || dom > 31) return null;
  return {
    day: `${d[3]}-${String(month).padStart(2, '0')}-${String(dom).padStart(2, '0')}`,
    hour: Number(d[4] ?? t?.[1] ?? 0),
    minute: Number(d[5] ?? t?.[2] ?? 0),
    second: Number(d[6] ?? t?.[3] ?? 0),
  };
}
