import type { ProviderId, ProviderMode } from '@ledger-lens/contracts';
import type { Clock } from '../../clock';
import { type Calendar } from '../../domain/calendar';
import type { DiagnosticsCollector } from '../../domain/diagnostics';
import { AppError } from '../../errors';
import {
  TokenRejectedError,
  type AccountRef,
  type BankingProvider,
  type CallContext,
  type ProviderAccount,
  type ProviderLimits,
  type ProviderTransaction,
  type RatePair,
  type TokenSet,
  type TransactionWindow,
} from '../port';
import { normaliseToken } from '../token';
import type { HttpRequest, HttpResult, ProviderHttp } from '../transport';
import { currencyFromNumeric, isKnownCurrency } from './currency';
import {
  AccountDto,
  CLIENT_ACCOUNT_FIELDS,
  CLIENT_JAR_FIELDS,
  JarDto,
  RateDto,
  STATEMENT_FIELDS,
  StatementItemDto,
  parseRows,
  type StatementItem,
} from './dto';

export interface MonobankDeps {
  id: ProviderId;
  mode: ProviderMode;
  label: string;
  http: ProviderHttp;
  apiUrl: string;
  limits: ProviderLimits;
  calendar: Calendar;
  clock: Clock;
  diagnostics: DiagnosticsCollector;
  /** Public rates come from here; the demo reads the real bank's rates and falls back to its own. */
  ratesUrl?: string;
}

/** The largest range one statement read accepts is 31 days and one hour. */
const MAX_RANGE_SECONDS = 2_682_000;

const CARD_LABELS: Readonly<Record<string, string>> = {
  black: 'Black',
  white: 'White',
  platinum: 'Platinum',
  iron: 'Iron',
  yellow: 'Kids',
  fop: 'FOP',
  eAid: 'eSupport',
};
/** Which card is "the main one" when there are several: the lowest number wins. */
const CARD_RANK: Readonly<Record<string, number>> = {
  black: 0,
  platinum: 1,
  iron: 2,
  white: 3,
  yellow: 4,
  fop: 5,
  eAid: 6,
};
const CURRENCY_FIELDS = new Set([
  'currencyCodeA',
  'currencyCodeB',
  'date',
  'rateBuy',
  'rateSell',
  'rateCross',
]);

const last4 = (value: string | null | undefined): string | null => {
  const digits = value?.replace(/\D/g, '') ?? '';
  return digits.length >= 4 ? digits.slice(-4) : null;
};

export { normaliseToken };

/**
 * monobank, personal API. The person pastes a read-only token issued at api.monobank.ua; everything here reads that
 * person's own accounts. There is no consent window, no refresh and no payment initiation, and reads are limited to one a
 * minute per endpoint, which is why the sync worker paces itself from `limits` and nothing here caches or retries.
 *
 * The same class is the demo: the demo provider is this adapter with its transport pointed at an in-process fake bank, so
 * everything the demo shows has gone through the code a real connection uses.
 */
export class MonobankProvider implements BankingProvider {
  readonly id: ProviderId;
  readonly mode: ProviderMode;
  readonly label: string;
  readonly limits: ProviderLimits;

  constructor(private readonly deps: MonobankDeps) {
    this.id = deps.id;
    this.mode = deps.mode;
    this.label = deps.label;
    this.limits = deps.limits;
  }

  // ----------------------------------------------------------------------------- plumbing

  private async call(ctx: CallContext, endpoint: string, spec: HttpRequest): Promise<HttpResult> {
    const started = performance.now();
    try {
      const result = await this.deps.http.request(ctx, spec);
      this.deps.diagnostics.recordCall(
        endpoint,
        result.status,
        Math.round(performance.now() - started),
      );
      return result;
    } catch (error) {
      this.deps.diagnostics.recordCall(endpoint, null, Math.round(performance.now() - started));
      throw error;
    }
  }

  private fail(endpoint: string, response: HttpResult): never {
    if (response.status === 403 || response.status === 401) {
      throw new TokenRejectedError('monobank does not accept the token');
    }
    if (response.status === 429) {
      const retry = Number(response.headers['retry-after']);
      throw new AppError('rate_limited', 429, 'monobank allows one read a minute. Waiting.', {
        retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : 60,
      });
    }
    if (response.status >= 500) {
      throw new AppError('bank_unavailable', 503, 'monobank is not responding.');
    }
    this.deps.diagnostics.warn(`${endpoint}: unexpected status ${response.status}`);
    throw new AppError(
      'provider_error',
      502,
      `monobank answered with an unexpected status (${response.status}).`,
    );
  }

  private unreadable(endpoint: string): never {
    this.deps.diagnostics.warn(`${endpoint}: response was not the JSON shape the docs describe`);
    throw new AppError('provider_error', 502, 'monobank sent an answer this app could not read.');
  }

  // ----------------------------------------------------------------------------- connecting

  async connect(
    input: { token: string },
    ctx: CallContext,
  ): Promise<{ tokens: TokenSet; accounts: ProviderAccount[] }> {
    const token = normaliseToken(input.token);
    if (!/^[A-Za-z0-9_\-+/=.]{16,128}$/.test(token)) {
      throw new AppError('validation_failed', 400, 'That does not look like a monobank token.', {
        errors: [
          {
            path: 'token',
            message:
              'Copy the whole token from api.monobank.ua (it is one long line without spaces).',
          },
        ],
      });
    }
    const tokens: TokenSet = { accessToken: token };
    try {
      return { tokens, accounts: await this.fetchAccounts(tokens, ctx) };
    } catch (error) {
      if (error instanceof TokenRejectedError) {
        throw new AppError('validation_failed', 400, 'monobank did not accept this token.', {
          errors: [
            {
              path: 'token',
              message:
                'monobank does not recognise this token. Copy all of it, or issue a new one.',
            },
          ],
          cause: error,
        });
      }
      throw error;
    }
  }

  revoke(): Promise<void> {
    // monobank has no way to withdraw a token through the API: it stays valid until the person issues a new one.
    return Promise.resolve();
  }

  // ----------------------------------------------------------------------------- accounts

  async fetchAccounts(tokens: TokenSet, ctx: CallContext): Promise<ProviderAccount[]> {
    const response = await this.call(ctx, 'client-info', {
      label: 'Get client info',
      method: 'GET',
      url: `${this.deps.apiUrl}/personal/client-info`,
      headers: { 'x-token': tokens.accessToken },
    });
    if (!response.ok) this.fail('client-info', response);
    const body = response.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body))
      this.unreadable('client-info');

    const record = body as Record<string, unknown>;
    const rawAccounts = Array.isArray(record['accounts']) ? (record['accounts'] as unknown[]) : [];
    const rawJars = Array.isArray(record['jars']) ? (record['jars'] as unknown[]) : [];
    const { diagnostics } = this.deps;
    diagnostics.observeRows('client-info.accounts', rawAccounts, CLIENT_ACCOUNT_FIELDS);
    diagnostics.observeRows('client-info.jars', rawJars, CLIENT_JAR_FIELDS);

    const cards = parseRows(AccountDto, rawAccounts);
    const jars = parseRows(JarDto, rawJars);
    for (const failure of [...cards.failures, ...jars.failures]) {
      diagnostics.warn(`client-info: skipped an account or jar (${failure})`);
    }
    if (rawAccounts.length + rawJars.length > 0 && cards.items.length + jars.items.length === 0) {
      this.unreadable('client-info');
    }

    const ordered = cards.items
      .map((item, index) => ({ item, index }))
      .sort((a, b) => {
        const au = currencyFromNumeric(a.item.currencyCode) === 'UAH' ? 0 : 1;
        const bu = currencyFromNumeric(b.item.currencyCode) === 'UAH' ? 0 : 1;
        return (
          au - bu ||
          (CARD_RANK[a.item.type ?? ''] ?? 9) - (CARD_RANK[b.item.type ?? ''] ?? 9) ||
          a.index - b.index
        );
      });

    const accounts: ProviderAccount[] = ordered.map(({ item }, sort) => {
      const currency = currencyFromNumeric(item.currencyCode);
      if (!isKnownCurrency(item.currencyCode)) {
        diagnostics.warn(`client-info: unknown currency code ${item.currencyCode}`);
      }
      const type = item.type ?? 'card';
      const label = CARD_LABELS[type] ?? (type === 'card' ? 'Card' : type);
      return {
        providerAccountId: item.id,
        kind: 'card',
        cardType: type,
        name: currency === 'UAH' ? label : `${label} ${currency}`,
        currency,
        last4: last4(item.maskedPan?.[0]) ?? last4(item.iban),
        creditLimitMinor: Math.max(0, item.creditLimit ?? 0),
        balanceMinor: item.balance,
        goalMinor: null,
        sort,
      };
    });
    jars.items.forEach((jar, index) => {
      const currency = currencyFromNumeric(jar.currencyCode);
      if (!isKnownCurrency(jar.currencyCode)) {
        diagnostics.warn(`client-info: unknown currency code ${jar.currencyCode}`);
      }
      accounts.push({
        providerAccountId: jar.id,
        kind: 'jar',
        cardType: 'jar',
        name: jar.title?.trim() || 'Jar',
        currency,
        last4: null,
        creditLimitMinor: 0,
        balanceMinor: jar.balance,
        goalMinor: jar.goal && jar.goal > 0 ? jar.goal : null,
        sort: accounts.length + index,
      });
    });
    return accounts;
  }

  // ----------------------------------------------------------------------------- transactions

  async fetchTransactions(
    tokens: TokenSet,
    account: AccountRef,
    window: TransactionWindow,
    ctx: CallContext,
  ): Promise<ProviderTransaction[]> {
    const { calendar, clock, diagnostics } = this.deps;
    const nowSeconds = Math.floor(clock.now().getTime() / 1000);
    const to = Math.min(Math.floor(calendar.dayEnd(window.to) / 1000), nowSeconds);
    const from = Math.max(
      Math.floor(calendar.dayStart(window.from) / 1000),
      to - MAX_RANGE_SECONDS,
    );
    if (to <= from) return [];

    const response = await this.call(ctx, 'statement', {
      label: 'List transactions',
      method: 'GET',
      url: `${this.deps.apiUrl}/personal/statement/${encodeURIComponent(account.providerAccountId)}/${from}/${to}`,
      headers: { 'x-token': tokens.accessToken },
    });
    if (!response.ok) this.fail('statement', response);
    if (!Array.isArray(response.body)) this.unreadable('statement');

    const raw = response.body as unknown[];
    diagnostics.observeRows('statement', raw, STATEMENT_FIELDS);
    const { items, failures } = parseRows(StatementItemDto, raw);
    for (const failure of failures) diagnostics.warn(`statement: skipped a row (${failure})`);

    const seen = new Set<string>();
    const rows: ProviderTransaction[] = [];
    for (const item of items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      if (!isKnownCurrency(item.currencyCode)) {
        diagnostics.warn(`statement: unknown currency code ${item.currencyCode}`);
      }
      rows.push(this.mapItem(item));
    }
    return rows.sort((a, b) => b.ts - a.ts || (a.providerTxnId < b.providerTxnId ? 1 : -1));
  }

  private mapItem(item: StatementItem): ProviderTransaction {
    const clean = (value: string | null | undefined): string | null => {
      const squeezed = value?.replace(/\s+/g, ' ').trim();
      return squeezed ? squeezed : null;
    };
    return {
      providerTxnId: item.id,
      ts: item.time * 1000,
      status: item.hold ? 'pending' : 'booked',
      amountMinor: item.amount,
      currency: currencyFromNumeric(item.currencyCode),
      description: clean(item.description) ?? 'Transaction',
      // Card purchases name the merchant in the description; only some transfers name a counterparty.
      counterparty: clean(item.counterName),
      mcc: item.mcc && item.mcc > 0 ? item.mcc : null,
      cashbackMinor: Math.max(0, item.cashbackAmount ?? 0),
      commissionMinor: Math.max(0, item.commissionRate ?? 0),
      comment: clean(item.comment),
      receiptId: clean(item.receiptId),
      balanceAfterMinor: item.balance ?? null,
    };
  }

  // ----------------------------------------------------------------------------- rates

  async fetchRates(ctx: CallContext): Promise<RatePair[]> {
    const response = await this.call(ctx, 'currency', {
      label: 'Get exchange rates',
      method: 'GET',
      url: `${this.deps.ratesUrl ?? this.deps.apiUrl}/bank/currency`,
      timeoutMs: 8_000,
    });
    if (!response.ok) this.fail('currency', response);
    if (!Array.isArray(response.body)) this.unreadable('currency');
    const raw = response.body as unknown[];
    this.deps.diagnostics.observeRows('currency', raw, CURRENCY_FIELDS);
    const { items, failures } = parseRows(RateDto, raw);
    for (const failure of failures)
      this.deps.diagnostics.warn(`currency: skipped a pair (${failure})`);

    const pairs: RatePair[] = [];
    for (const item of items) {
      if (!isKnownCurrency(item.currencyCodeA) || !isKnownCurrency(item.currencyCodeB)) continue;
      pairs.push({
        a: currencyFromNumeric(item.currencyCodeA),
        b: currencyFromNumeric(item.currencyCodeB),
        buy: item.rateBuy ?? null,
        sell: item.rateSell ?? null,
        cross: item.rateCross ?? null,
        date: item.date ?? 0,
      });
    }
    return pairs;
  }
}
