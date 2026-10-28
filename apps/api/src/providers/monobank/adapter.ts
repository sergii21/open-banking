import { createHash } from 'node:crypto';
import {
  maskIdentifier,
  type Institution,
  type InstitutionQuery,
  type Permission,
} from '@ledger-lens/contracts';
import type { Clock } from '../../clock';
import type { MonobankConfig } from '../../config';
import { AppError } from '../../errors';
import {
  InvalidGrantError,
  TokenRejectedError,
  type AccountRef,
  type BankingProvider,
  type CallbackResult,
  type CallContext,
  type ConnectionGrant,
  type ProviderAccount,
  type ProviderBalance,
  type ProviderLimits,
  type ProviderTransaction,
  type TokenSet,
  type TransactionWindow,
} from '../port';
import { parseDto } from '../shared/data-api';
import type { HttpResult, ProviderHttp } from '../transport';
import { currencyFromNumeric } from './currency';
import { ClientInfoDto, StatementDto, type ClientInfo, type StatementItem } from './dto';
import { monobankInstitutions } from './institutions';

export interface MonobankDeps {
  http: ProviderHttp;
  config: MonobankConfig;
  clock: Clock;
}

const INFO_CACHE_MS = 60_000;
/** The largest range one statement request accepts is 31 days and one hour; windows stay at 31 days. */
const MAX_WINDOW_DAYS = 31;
const MAX_ITEMS = 500;
const TEN_YEARS_MS = 10 * 365 * 86_400_000;
const PERMISSIONS: Permission[] = ['accounts', 'balances', 'transactions'];

const CARD_LABELS: Readonly<Record<string, string>> = {
  black: 'Black card',
  white: 'White card',
  platinum: 'Platinum card',
  iron: 'Iron card',
  yellow: 'Kids card',
  fop: 'FOP account',
  eAid: 'eSupport card',
};

const unixSeconds = (iso: string, endOfDay: boolean): number =>
  Math.floor(Date.parse(`${iso}T${endOfDay ? '23:59:59' : '00:00:00'}Z`) / 1000);

/**
 * monobank (Ukraine), personal API. This is a real bank: the customer pastes a read-only token issued at
 * api.monobank.ua, and everything here reads that customer's own accounts. There is no consent window, no refresh token
 * and no payment initiation, and reads are rate-limited to one per minute, which is why the sync worker paces itself
 * from `limits` and why client-info is cached for a minute.
 */
export class MonobankProvider implements BankingProvider {
  readonly id = 'monobank' as const;
  readonly mode = 'live' as const;
  readonly label = 'monobank';
  readonly limits: ProviderLimits;

  private readonly info = new Map<string, { at: number; value: ClientInfo }>();

  constructor(private readonly deps: MonobankDeps) {
    this.limits = {
      // monobank allows one statement request per minute per token; the default of 61 s leaves a little slack.
      minIntervalMs: deps.config.minIntervalSeconds * 1000,
      maxWindowDays: MAX_WINDOW_DAYS,
      maxItemsPerCall: MAX_ITEMS,
      historyMonths: deps.config.historyMonths,
    };
  }

  listInstitutions(query: InstitutionQuery): Promise<Institution[]> {
    return Promise.resolve(monobankInstitutions(query));
  }

  // ----------------------------------------------------------------------------- connecting (token, not redirect)

  startConnection(): Promise<{ authUrl: string }> {
    return Promise.reject(
      new AppError('validation_failed', 400, 'monobank connects with a token, not a redirect.'),
    );
  }

  parseCallback(): CallbackResult {
    return { kind: 'failure', outcome: 'error', detail: 'monobank has no redirect' };
  }

  completeConnection(): Promise<ConnectionGrant> {
    return Promise.reject(
      new AppError('validation_failed', 400, 'monobank connects with a token, not a redirect.'),
    );
  }

  async connectWithToken(input: { token: string }, ctx: CallContext): Promise<ConnectionGrant> {
    const tokens: TokenSet = {
      accessToken: input.token,
      refreshToken: null,
      expiresAt: new Date(this.deps.clock.now().getTime() + TEN_YEARS_MS).toISOString(),
      scope: PERMISSIONS.join(' '),
    };
    try {
      // A real call, so a mistyped token fails here instead of on the first dashboard load. The answer is cached, so
      // the first sync does not spend a second request inside the same minute.
      await this.clientInfo(tokens, ctx, true);
    } catch (error) {
      if (error instanceof TokenRejectedError) {
        throw new AppError('validation_failed', 400, 'monobank did not accept this token.', {
          errors: [
            { path: 'token', message: 'monobank does not recognise this token. Copy all of it.' },
          ],
          cause: error,
        });
      }
      throw error;
    }
    return { tokens, consentExpiresAt: null, permissions: PERMISSIONS };
  }

  /** A personal token cannot be refreshed: when monobank stops accepting it the customer issues a new one. */
  refreshTokens(): Promise<TokenSet> {
    return Promise.reject(new InvalidGrantError('monobank tokens cannot be refreshed'));
  }

  fetchConsent(): Promise<{ expiresAt: string | null; permissions: Permission[] }> {
    return Promise.resolve({ expiresAt: null, permissions: PERMISSIONS });
  }

  // ----------------------------------------------------------------------------- reading

  private fingerprint(tokens: TokenSet): string {
    return createHash('sha256').update(tokens.accessToken).digest('hex').slice(0, 16);
  }

  private fail(response: HttpResult): never {
    if (response.status === 403) throw new TokenRejectedError('monobank does not accept the token');
    if (response.status === 429) {
      const retry = Number(response.headers['retry-after']);
      throw new AppError(
        'rate_limited',
        429,
        'monobank allows one request per minute for this. Try again shortly.',
        { retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : 60 },
      );
    }
    if (response.status >= 500) {
      throw new AppError('bank_unavailable', 503, 'monobank is temporarily unavailable.');
    }
    throw new AppError(
      'provider_error',
      502,
      `monobank responded with an unexpected status (${response.status}).`,
    );
  }

  private async clientInfo(tokens: TokenSet, ctx: CallContext, fresh = false): Promise<ClientInfo> {
    const key = this.fingerprint(tokens);
    const now = this.deps.clock.now().getTime();
    const cached = this.info.get(key);
    if (!fresh && cached && now - cached.at < INFO_CACHE_MS) return cached.value;

    const response = await this.deps.http.request(ctx, {
      label: 'Get client info',
      method: 'GET',
      url: `${this.deps.config.apiUrl}/personal/client-info`,
      headers: { 'x-token': tokens.accessToken },
    });
    if (!response.ok) this.fail(response);
    const value = parseDto(ClientInfoDto, response.body, 'client info');
    this.info.set(key, { at: now, value });
    return value;
  }

  async fetchAccounts(tokens: TokenSet, ctx: CallContext): Promise<ProviderAccount[]> {
    const info = await this.clientInfo(tokens, ctx);
    const at = this.deps.clock.now().toISOString();

    const cards = info.accounts.map((account): ProviderAccount => {
      const currency = currencyFromNumeric(account.currencyCode);
      const credit = account.creditLimit ?? 0;
      const last4 = account.maskedPan?.[0]?.slice(-4);
      return {
        providerAccountId: account.id,
        name: `${CARD_LABELS[account.type] ?? 'Account'}${currency === 'UAH' ? '' : ` ${currency}`}`,
        type: 'current',
        currency,
        // `balance` includes the credit limit, so own funds are what is left after taking it off.
        balance: { amountMinor: account.balance - credit, currency },
        availableBalance: { amountMinor: account.balance, currency },
        at,
        maskedIdentifier: account.iban
          ? maskIdentifier(account.iban)
          : last4
            ? `•••• ${last4}`
            : null,
      };
    });
    const jars = (info.jars ?? []).map((jar): ProviderAccount => {
      const currency = currencyFromNumeric(jar.currencyCode);
      return {
        providerAccountId: jar.id,
        name: jar.title,
        type: 'savings',
        currency,
        balance: { amountMinor: jar.balance, currency },
        availableBalance: { amountMinor: jar.balance, currency },
        at,
        maskedIdentifier: null,
      };
    });
    return [...cards, ...jars];
  }

  async fetchBalance(
    tokens: TokenSet,
    account: AccountRef,
    ctx: CallContext,
  ): Promise<ProviderBalance> {
    const accounts = await this.fetchAccounts(tokens, ctx);
    const match = accounts.find((a) => a.providerAccountId === account.providerAccountId);
    if (!match) throw new AppError('not_found', 404, 'monobank no longer lists that account.');
    return { balance: match.balance, availableBalance: match.availableBalance, at: match.at };
  }

  async fetchTransactions(
    tokens: TokenSet,
    account: AccountRef,
    window: TransactionWindow,
    ctx: CallContext,
  ): Promise<ProviderTransaction[]> {
    const nowSeconds = Math.floor(this.deps.clock.now().getTime() / 1000);
    const from = unixSeconds(window.from, false);
    const to = Math.min(unixSeconds(window.to, true), nowSeconds);
    if (to <= from) return [];

    const response = await this.deps.http.request(ctx, {
      label: 'List transactions',
      method: 'GET',
      url: `${this.deps.config.apiUrl}/personal/statement/${encodeURIComponent(account.providerAccountId)}/${from}/${to}`,
      headers: { 'x-token': tokens.accessToken },
    });
    if (!response.ok) this.fail(response);

    const seen = new Set<string>();
    return parseDto(StatementDto, response.body, 'statement')
      .map((item) => this.mapItem(item))
      .filter((row) => (seen.has(row.providerTxnId) ? false : (seen.add(row.providerTxnId), true)));
  }

  private mapItem(item: StatementItem): ProviderTransaction {
    const text = item.description?.trim() ?? '';
    const note = item.comment?.trim() ?? '';
    return {
      providerTxnId: item.id,
      bookedAt: new Date(item.time * 1000).toISOString(),
      status: item.hold ? 'pending' : 'booked',
      amount: { amountMinor: item.amount, currency: currencyFromNumeric(item.currencyCode) },
      description: [text, note].filter(Boolean).join(' – ') || 'Transaction',
      // For card purchases the merchant is the description itself; only transfers name a counterparty.
      counterparty: item.counterName?.trim() || null,
      providerCategory: item.mcc ? `MCC:${item.mcc}` : null,
    };
  }

  /** monobank has no way to withdraw a token through the API: the customer issues a new one at api.monobank.ua. */
  revoke(tokens: TokenSet): Promise<void> {
    this.info.delete(this.fingerprint(tokens));
    return Promise.resolve();
  }
}
