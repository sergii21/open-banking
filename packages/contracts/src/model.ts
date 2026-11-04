import type { BankId, ProviderId } from './common';

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
  /** `api`: read with a token the person issued, kept in step with the bank. `file`: a statement the person imported. */
  kind: 'api' | 'file';
  bank: BankId;
  /** True for the built-in demo data: the screens say so wherever money is shown. */
  demo: boolean;
  label: string;
  status: 'active' | 'needs_reauth' | 'error';
  connectedAt: string;
  lastSyncAt: string | null;
  /** Months of history the loader reads; 0 for an imported file. */
  historyMonths: number;
}

export interface SessionInfo {
  id: string;
  createdAt: string;
  version: string;
  /** Whether connecting a real bank is allowed here (it is only on this machine). */
  live: boolean;
  /** The IANA zone days and months are cut in; screens group by day in the same zone. */
  timeZone: string;
  /** Every bank connected in this session, oldest first. The demo, when it is on, is the only one. */
  connections: ConnectionInfo[];
}

// ---------------------------------------------------------------------------------------------- sync

/** The loader across every connection of the session: the busiest phase wins, steps add up, the nearest next step is shown. */
export interface SyncState {
  /**
   * `idle`: everything is loaded. `loading`: a step is running. `waiting`: steps are queued and a bank's read limit is the
   * reason nothing is running. `attention`: something needs the person (token rejected, bank down).
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
  connectionId: string;
  bank: BankId;
  /** `file`: read from an imported statement, so it is only as current as the file. */
  source: 'api' | 'file';
  kind: 'card' | 'jar';
  /** monobank's card type (black, white, platinum, iron, fop, yellow, eAid), `business` (PrivatBank), `privat24` (a file) or `jar`. */
  type: string;
  name: string;
  currency: string;
  last4: string | null;
  /** False when the imported file carried no balance: the amount below is 0 and the screens say there is none. */
  balanceKnown: boolean;
  /** The days an imported statement covers and when it was imported; null for an account read from the bank. */
  imported: { from: string; to: string; at: string } | null;
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
    /** Imported accounts left out of the total because their file carried no balance. */
    unknownBalance: number;
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
  /** The month is still running, so the earlier month is counted only for the same days. */
  previousIsSameDays: boolean;
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

// ---------------------------------------------------------------------------------------------- import

/** What reading a Privat24 statement file did. Counts and names only: no description, amount or card number. */
export interface ImportResult {
  /** Every connection of the session after the import (the file becomes one of them). */
  connections: ConnectionInfo[];
  /** The days the statement covers: the period it states, or its first and last row. */
  period: { from: string; to: string };
  rows: { read: number; added: number; updated: number; skipped: number };
  /** One entry per card found in the file. */
  cards: {
    accountId: string;
    last4: string | null;
    currency: string;
    added: number;
    updated: number;
    balanceKnown: boolean;
  }[];
  /** Things the person should know, in plain words (an assumed currency, rows that were not transactions). */
  notes: string[];
}

// ---------------------------------------------------------------------------------------------- Wise draft transfers

/** A Wise balance a draft can be priced from. `group` is the same for balances of one Wise profile, which share recipients. */
export interface WiseDraftSource {
  accountId: string;
  name: string;
  currency: string;
  balanceMinor: number;
  group: number;
}

export interface WiseDraftRecipient {
  id: number;
  name: string;
  currency: string;
  summary: string | null;
}

/** A transfer waiting for payment in Wise. Its amount is what the recipient gets: Wise's source value can read 0 until it is paid. */
export interface WiseWaitingDraft {
  id: number;
  targetMinor: number;
  targetCurrency: string;
  recipientName: string | null;
  createdOn: string | null;
}

export interface WiseDraftOverview {
  sources: WiseDraftSource[];
  /** The balance the recipients and waiting transfers below were read for. */
  accountId: string;
  recipients: WiseDraftRecipient[];
  /** There are more recipients in Wise than were read. */
  moreRecipients: boolean;
  waiting: WiseWaitingDraft[];
}

export interface WiseDraftQuote {
  quoteId: string;
  /** Sent back to create the draft: a repeat with the same key never creates a second transfer. */
  draftKey: string;
  sourceMinor: number;
  sourceCurrency: string;
  targetMinor: number;
  targetCurrency: string;
  feeMinor: number | null;
  rate: string | null;
  expiresAt: string | null;
  /** False when the price shown is for another way of paying than a Wise balance. */
  fromBalance: boolean;
}

export interface WiseDraftCreated {
  /** Null when Wise said yes in an answer that could not be read: the transfer exists, look for it in Wise. */
  transferId: number | null;
}

// ---------------------------------------------------------------------------------------------- events

/** Server-sent events on `GET /api/events`. The SSE `event:` field is the `type`. */
export type ServerEvent =
  | { type: 'sync.updated'; sync: SyncState }
  | { type: 'connection.updated'; connections: ConnectionInfo[] }
  | { type: 'inspector.call'; call: InspectorCall };

export const SERVER_EVENT_TYPES = ['sync.updated', 'connection.updated', 'inspector.call'] as const;
