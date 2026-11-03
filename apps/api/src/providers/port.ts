import type { ProviderId, ProviderMode } from '@ledger-lens/contracts';

/** Who a provider call is made for; the Live API drawer files the call under this session. */
export interface CallContext {
  sessionId: string;
  connectionId: string | null;
}

/** The credential for one connection. Sealed with the TokenVault before it touches the database. */
export interface TokenSet {
  accessToken: string;
}

export interface ProviderAccount {
  providerAccountId: string;
  kind: 'card' | 'jar';
  /** The bank's own type (black, white, platinum, iron, fop, yellow, eAid) or `jar`. */
  cardType: string;
  name: string;
  currency: string;
  /** Already reduced to the last four digits; the adapter never hands the full card number or IBAN to the core. */
  last4: string | null;
  creditLimitMinor: number;
  /** As the bank reports it: includes the credit limit. The core subtracts it to get own funds. */
  balanceMinor: number;
  goalMinor: number | null;
  /** Display order: the main card first. */
  sort: number;
}

export interface ProviderTransaction {
  /** Stable id from the provider. */
  providerTxnId: string;
  /** Unix milliseconds. */
  ts: number;
  status: 'pending' | 'booked';
  /** In the account's currency; negative is money out. */
  amountMinor: number;
  currency: string;
  description: string;
  counterparty: string | null;
  mcc: number | null;
  cashbackMinor: number;
  commissionMinor: number;
  comment: string | null;
  receiptId: string | null;
  balanceAfterMinor: number | null;
}

export interface TransactionWindow {
  /** Inclusive calendar dates in the configured time zone, YYYY-MM-DD. */
  from: string;
  to: string;
}

export interface AccountRef {
  providerAccountId: string;
  currency: string;
}

export interface RatePair {
  /** Alphabetic ISO 4217 codes. Rates are units of B per one unit of A. */
  a: string;
  b: string;
  buy: number | null;
  sell: number | null;
  cross: number | null;
  /** Unix seconds, when the bank last updated the pair. */
  date: number;
}

/** Providers that cap how fast data may be read declare it, and the sync worker paces itself to match. */
export interface ProviderLimits {
  /** Minimum gap between two statement reads for one token. */
  statementIntervalMs: number;
  /** Minimum gap between two reads of the account list for one token. */
  infoIntervalMs: number;
  /** Longest window one statement read may cover, in days. */
  maxWindowDays: number;
  /** A response with this many rows may have been cut short: ask for the rest of the window. */
  maxItemsPerCall: number;
  /** How far back background history loading goes. */
  historyMonths: number;
  /** The bank documents one limit for every endpoint, so the two gates start joined instead of learning it from a 429. */
  sharedLimit?: boolean;
}

/**
 * The seam between Ledger Lens and a bank. An adapter owns its provider's wire format and hands the core normalised
 * types; it never touches the database. See `.claude/skills/provider-adapter`.
 */
export interface BankingProvider {
  readonly id: ProviderId;
  readonly mode: ProviderMode;
  readonly label: string;
  readonly limits: ProviderLimits;

  /**
   * Checks a token the person issued at the bank with a real call and returns what it grants. The accounts come back with
   * it so the caller does not spend a second read (the bank allows one a minute).
   */
  connect(
    input: { token: string },
    ctx: CallContext,
  ): Promise<{ tokens: TokenSet; accounts: ProviderAccount[] }>;
  fetchAccounts(tokens: TokenSet, ctx: CallContext): Promise<ProviderAccount[]>;
  /** Booked and pending transactions for the window, newest first, de-duplicated. */
  fetchTransactions(
    tokens: TokenSet,
    account: AccountRef,
    window: TransactionWindow,
    ctx: CallContext,
  ): Promise<ProviderTransaction[]>;
  /** Public exchange rates; no token needed. */
  fetchRates(ctx: CallContext): Promise<RatePair[]>;
  /** Best effort: local data is deleted even if this fails. */
  revoke(tokens: TokenSet, ctx: CallContext): Promise<void>;
}

/** The token was rejected (replaced or revoked at the bank, or never valid): the person has to paste a new one. */
export class TokenRejectedError extends Error {
  override name = 'TokenRejectedError';
}
