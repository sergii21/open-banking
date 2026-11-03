import type { ProviderId } from './common';

// ---------------------------------------------------------------------------------------------- categories

export const CATEGORIES = [
  'groceries',
  'dining',
  'transport',
  'shopping',
  'bills',
  'subscriptions',
  'health',
  'entertainment',
  'travel',
  'transfers',
  'income',
  'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

// ---------------------------------------------------------------------------------------------- session

export interface ConnectionInfo {
  id: string;
  provider: ProviderId;
  /** True for the built-in demo data: the screens say so wherever money is shown. */
  demo: boolean;
  label: string;
  status: 'active' | 'needs_reauth' | 'error';
  connectedAt: string;
  lastSyncAt: string | null;
  historyMonths: number;
}

export interface SessionInfo {
  id: string;
  createdAt: string;
  version: string;
  /** Whether connecting a real monobank token is allowed here (it is only on this machine). */
  live: boolean;
  connection: ConnectionInfo | null;
}

// ---------------------------------------------------------------------------------------------- sync

export interface SyncState {
  /**
   * `idle`: everything is loaded. `loading`: a step is running. `waiting`: steps are queued and the bank's one-read-a-minute
   * limit is the reason nothing is running. `attention`: something needs the person (token rejected, bank down).
   */
  phase: 'idle' | 'loading' | 'waiting' | 'attention';
  /** When data last arrived from the bank. */
  updatedAt: string | null;
  /** Steps finished and steps in the current batch (a step is one statement window of one account). */
  done: number;
  total: number;
  /** When the next step may run, if one is queued. */
  nextAt: string | null;
  /** When balances may be read again (monobank allows one read of the account list a minute); null when they may be now. */
  balancesNextAt: string | null;
  needsToken: boolean;
  /** What happened, in words for the person, when `phase` is `attention`. */
  message: string | null;
  /** Grows whenever stored data changed; screens reload their data when it moves. */
  version: number;
}

// ---------------------------------------------------------------------------------------------- accounts and home

export interface Account {
  id: string;
  kind: 'card' | 'jar';
  /** monobank's card type (black, white, platinum, iron, fop, yellow, eAid) or `jar`. */
  type: string;
  name: string;
  currency: string;
  last4: string | null;
  /** Own money in the account currency: the balance minus any credit limit. */
  ownMinor: number;
  /** What can be spent now: own money plus unused credit. Equals `ownMinor` without a credit limit. */
  availableMinor: number;
  creditLimitMinor: number;
  goalMinor: number | null;
  /** Own money in UAH at today's rate; null when monobank publishes no rate for the currency. */
  ownUahMinor: number | null;
  /** First day of loaded history and whether more is on its way. */
  history: { state: 'done' | 'loading' | 'queued'; from: string | null };
}

export interface RatesInfo {
  /** When monobank last updated the rates, and whether what we show is older than a successful refresh. */
  asOf: string | null;
  stale: boolean;
  /** Units of UAH per one unit of currency, for the currencies the person holds. */
  perUnit: Record<string, number>;
}

export interface Home {
  asOf: string;
  demo: boolean;
  hero: {
    ownUahMinor: number;
    availableUahMinor: number;
    /** Accounts left out of the total because there is no rate for their currency. */
    unconverted: number;
  };
  rates: RatesInfo;
  /** Own money per day for the last 30 days (UAH minor units, oldest first); null until every account has enough history. */
  trend: { from: string; points: number[] } | null;
  month: {
    /** `YYYY-MM` */
    label: string;
    daysElapsed: number;
    daysInMonth: number;
    spentMinor: number;
    incomeMinor: number;
    /** The same days last month; null while last month is not fully loaded, so a wrong delta is never shown. */
    previousSameDaysMinor: number | null;
    /** Spending per day of this month, index 0 is the 1st. */
    daily: number[];
    projectedMinor: number | null;
  };
  accounts: Account[];
  topCategories: { category: Category; spentMinor: number; share: number }[];
  regular: { count: number; monthlyMinor: number };
  sync: SyncState;
}

// ---------------------------------------------------------------------------------------------- activity

export interface ActivityRow {
  id: string;
  accountId: string;
  /** Unix milliseconds. */
  ts: number;
  status: 'pending' | 'booked';
  /** In the account's currency; negative is money out. */
  amountMinor: number;
  currency: string;
  description: string;
  category: Category;
  /** Present only when the person chose the category. */
  chosen?: true;
  /** Everything below is left out of the JSON when it is empty, which is most rows. */
  counterparty?: string;
  mcc?: number;
  cashbackMinor?: number;
  commissionMinor?: number;
  comment?: string;
  receiptId?: string;
  /** Balance of the account after this operation, when the bank says. */
  balanceAfterMinor?: number;
}

export interface Activity {
  rows: ActivityRow[];
  accounts: Account[];
  demo: boolean;
  version: number;
}

// ---------------------------------------------------------------------------------------------- insights

export interface RegularPayment {
  key: string;
  merchant: string;
  category: Category;
  cadence: 'weekly' | 'monthly' | 'quarterly' | 'yearly';
  /** A typical charge in UAH, positive. */
  amountMinor: number;
  occurrences: number;
  lastSeenAt: string;
  nextExpectedAt: string;
  monthlyMinor: number;
}

export interface Insights {
  /** `YYYY-MM` and the months that have data, newest first. */
  month: string;
  months: string[];
  spentMinor: number;
  incomeMinor: number;
  previousSpentMinor: number | null;
  categories: {
    category: Category;
    spentMinor: number;
    count: number;
    share: number;
    previousMinor: number | null;
  }[];
  merchants: { name: string; spentMinor: number; count: number; category: Category }[];
  regular: RegularPayment[];
  regularMonthlyMinor: number;
  /** History for this month is still loading. */
  partial: boolean;
  /** Foreign-currency accounts contributed, converted at today's rate. */
  converted: boolean;
}

// ---------------------------------------------------------------------------------------------- inspector

/** One outbound call to the bank, as shown in the Live API drawer. Everything here is already redacted. */
export interface InspectorCall {
  id: string;
  at: string;
  provider: ProviderId;
  label: string;
  method: string;
  url: string;
  /** Null when the request never produced a response (network error, timeout). */
  status: number | null;
  durationMs: number;
  request: { headers: Record<string, string>; body: unknown };
  response: { headers: Record<string, string>; body: unknown } | null;
  error: string | null;
  truncated: boolean;
  connectionId: string | null;
}

// ---------------------------------------------------------------------------------------------- events

/** Server-sent events on `GET /api/events`. The SSE `event:` field is the `type`. */
export type ServerEvent =
  | { type: 'sync.updated'; sync: SyncState }
  | { type: 'connection.updated'; connection: ConnectionInfo | null }
  | { type: 'inspector.call'; call: InspectorCall };

export const SERVER_EVENT_TYPES = ['sync.updated', 'connection.updated', 'inspector.call'] as const;
