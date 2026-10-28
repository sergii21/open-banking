import type {
  AccountType,
  ConnectOutcome,
  Institution,
  InstitutionQuery,
  Money,
  Permission,
  ProviderId,
  ProviderMode,
} from '@ledger-lens/contracts';

/** Who a provider call is made for; the Inspector files the call under this session. */
export interface CallContext {
  sessionId: string;
  connectionId: string | null;
  /**
   * The customer's own IP address when a call is made because they asked for it (Refresh, connecting). Providers that
   * accept it send it as `X-PSU-IP`, which tells the bank the customer is present, so the call does not count against
   * the cap on unattended reads.
   */
  psuIp?: string;
}

/** Provider credentials for one connection. Sealed with the TokenVault before it touches the database. */
export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** When the access token stops working (ISO 8601). */
  expiresAt: string;
  scope: string | null;
}

export interface StartConnectionInput {
  institutionId: string;
  state: string;
  codeChallenge: string;
  redirectUri: string;
}

export interface CompleteConnectionInput {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface ConnectionGrant {
  tokens: TokenSet;
  /** End of the bank consent; null when the provider does not report one. */
  consentExpiresAt: string | null;
  permissions: Permission[];
}

/** What the bank's redirect back to us means. Failures are mapped to the outcomes the UI has designed states for. */
export type CallbackResult =
  | { kind: 'code'; code: string }
  | {
      kind: 'failure';
      outcome: Exclude<ConnectOutcome, 'success' | 'invalid_state'>;
      detail: string;
    };

export interface ProviderBalance {
  balance: Money;
  availableBalance: Money | null;
  at: string;
}

export interface ProviderAccount extends ProviderBalance {
  providerAccountId: string;
  name: string;
  type: AccountType;
  currency: string;
  /** Already masked; the adapter never hands the full IBAN or account number to the core. */
  maskedIdentifier: string | null;
}

export interface ProviderTransaction {
  /** Stable id from the provider, or a deterministic hash when the provider has none (pending rows). */
  providerTxnId: string;
  bookedAt: string;
  status: 'pending' | 'booked';
  /** Signed: negative is money out. */
  amount: Money;
  description: string;
  counterparty: string | null;
  /** Provider's coarse type (TRANSFER, PURCHASE, ...) used as a categorisation hint. */
  providerCategory: string | null;
}

export interface TransactionWindow {
  /** Inclusive calendar dates, YYYY-MM-DD. */
  from: string;
  to: string;
}

export interface AccountRef {
  providerAccountId: string;
  currency: string;
}

/** Providers that cap how fast data may be read declare it, and the sync worker paces itself to match. */
export interface ProviderLimits {
  /** Minimum gap between two transaction reads for one connection. */
  minIntervalMs: number;
  /** Longest window one transaction read may cover, in days. */
  maxWindowDays: number;
  /** A response with this many rows may have been cut short: ask for the rest of the window. */
  maxItemsPerCall: number;
  /** How far back background history loading goes. */
  historyMonths: number;
}

/**
 * The seam between Ledger Lens and every bank or aggregator. An adapter owns its provider's wire format and
 * hands the core normalised types; it never touches the database. See `.claude/skills/provider-adapter`.
 */
export interface BankingProvider {
  readonly id: ProviderId;
  readonly mode: ProviderMode;
  readonly label: string;
  /** Present when the provider rate-limits reads; absent providers are read in full during the first sync. */
  readonly limits?: ProviderLimits;

  /**
   * Token-based providers only: check a token the customer issued at the bank and read what it grants. The token is
   * the credential from then on (no refresh), and it is validated with a real call so a typo fails here, not later.
   */
  connectWithToken?(input: { token: string }, ctx: CallContext): Promise<ConnectionGrant>;

  listInstitutions(query: InstitutionQuery, ctx: CallContext): Promise<Institution[]>;
  startConnection(input: StartConnectionInput, ctx: CallContext): Promise<{ authUrl: string }>;
  parseCallback(query: Record<string, string | undefined>): CallbackResult;
  completeConnection(input: CompleteConnectionInput, ctx: CallContext): Promise<ConnectionGrant>;
  refreshTokens(tokens: TokenSet, ctx: CallContext): Promise<TokenSet>;
  /** Current consent end and permissions; called on every user-initiated refresh so reminders stay accurate. */
  fetchConsent(
    tokens: TokenSet,
    ctx: CallContext,
  ): Promise<{ expiresAt: string | null; permissions: Permission[] }>;
  fetchAccounts(tokens: TokenSet, ctx: CallContext): Promise<ProviderAccount[]>;
  fetchBalance(tokens: TokenSet, account: AccountRef, ctx: CallContext): Promise<ProviderBalance>;
  /** Booked and pending transactions for the window, de-duplicated. */
  fetchTransactions(
    tokens: TokenSet,
    account: AccountRef,
    window: TransactionWindow,
    ctx: CallContext,
  ): Promise<ProviderTransaction[]>;
  /** Best effort: local data is deleted even if the provider call fails. */
  revoke(tokens: TokenSet, ctx: CallContext): Promise<void>;
}

/** The access token was rejected (expired or revoked). The caller refreshes once and retries. */
export class TokenRejectedError extends Error {
  override name = 'TokenRejectedError';
}

/** The refresh token is no longer valid: the user has to sign in at the bank again. */
export class InvalidGrantError extends Error {
  override name = 'InvalidGrantError';
}

/** The bank says the consent itself has ended. */
export class ConsentGoneError extends Error {
  override name = 'ConsentGoneError';
  constructor(readonly reason: 'expired' | 'revoked') {
    super(`Bank consent is ${reason}`);
  }
}
