import type {
  AccountType,
  BeneficiaryInput,
  ConnectOutcome,
  Institution,
  InstitutionQuery,
  Money,
  PaymentStatus,
  Permission,
  ProviderId,
  ProviderMode,
} from '@ledger-lens/contracts';
import type { PaymentUpdate } from '../domain/payment-state';

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
  /** See {@link CreatePaymentInput.customerRef}. */
  customerRef?: string;
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

// ===================================================================================== payment initiation

export interface CreatePaymentInput {
  /** Our payment id. Providers that accept free-form metadata echo it, so a payment can be traced from their dashboard. */
  clientReference: string;
  institutionId: string;
  amount: Money;
  /** Null when the institution pays a fixed account (`fixedPayee`). */
  beneficiary: BeneficiaryInput | null;
  reference: string;
  /** Sent as the provider's `Idempotency-Key`, so retrying a call whose outcome is unknown cannot create a second payment. */
  idempotencyKey: string;
  /** Where the bank sends the customer's browser back to once they have approved or abandoned the payment. */
  returnUri: string;
  /**
   * Opaque and stable per customer (a hash of the session id). Only the fake bank uses it, to show an executed payment
   * in that customer's own accounts and nobody else's.
   */
  customerRef: string;
  psuIp?: string;
}

export interface CreatedPayment {
  providerPaymentId: string;
  /** The bank's hosted page. It carries a short-lived resource token, so it is sealed at rest and only shown while pending. */
  authUrl: string;
  status: PaymentStatus;
  /** Whether a `settled` step follows `executed` (pay-ins to a merchant account settle, payments to an external account do not). */
  settlementExpected: boolean;
}

export interface WebhookRequest {
  method: string;
  /** Path as received, without the query string. The signature covers it. */
  path: string;
  headers: Record<string, string | string[] | undefined>;
  /** The exact bytes the provider sent: signatures are computed over them, so they are never re-serialised. */
  rawBody: Buffer;
}

export interface VerifiedWebhook {
  /** The provider's id for this event; the same event delivered twice shares it. */
  eventId: string;
  type: string;
  providerPaymentId: string;
  /** Null for event types that do not change a payment (they are acknowledged and ignored). */
  update: PaymentUpdate | null;
  /** The parsed body with secrets masked, for the Inspector and the event log. */
  payload: unknown;
}

/** What a provider adds when it can also send money. Check with {@link supportsPayments}. */
export interface PaymentInitiation {
  /** The account every payment goes to when the institution pays a fixed payee; null when the customer chooses. */
  fixedPayee(institutionId: string, currency: string): { name: string; identifier: string } | null;
  createPayment(input: CreatePaymentInput, ctx: CallContext): Promise<CreatedPayment>;
  /** Current state at the provider; the polling fallback and the return handler use it. */
  getPayment(providerPaymentId: string, ctx: CallContext): Promise<PaymentUpdate>;
  /**
   * Checks the signature (and, where the provider signs one, the timestamp) and reads the event. Throws
   * `invalid_webhook_signature` for anything that does not verify; nothing in the body is trusted before that.
   */
  verifyWebhook(request: WebhookRequest): Promise<VerifiedWebhook>;
}

export function supportsPayments(
  provider: BankingProvider,
): provider is BankingProvider & PaymentInitiation {
  const candidate = provider as Partial<PaymentInitiation>;
  return (
    typeof candidate.createPayment === 'function' &&
    typeof candidate.getPayment === 'function' &&
    typeof candidate.verifyWebhook === 'function' &&
    typeof candidate.fixedPayee === 'function'
  );
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
