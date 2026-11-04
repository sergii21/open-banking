import { createHash } from 'node:crypto';
import {
  currencyExponent,
  minorToDecimalString,
  type ProviderId,
  type ProviderMode,
} from '@ledger-lens/contracts';
import type { Clock } from '../../clock';
import { decimalToMinor } from '../../domain/decimal';
import type { DiagnosticsCollector } from '../../domain/diagnostics';
import { AppError } from '../../errors';
import { parseRows } from '../monobank/dto';
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
import type { HttpResult, ProviderHttp } from '../transport';
import {
  BALANCE_FIELDS,
  BalanceDto,
  CreatedTransferDto,
  PROFILE_FIELDS,
  ProfileDto,
  QUOTE_FIELDS,
  QuoteDto,
  RECIPIENT_FIELDS,
  RecipientDto,
  TRANSFER_FIELDS,
  TransferDto,
  parseKeepingAmounts,
} from './dto';

export interface WiseDeps {
  id: ProviderId;
  mode: ProviderMode;
  label: string;
  http: ProviderHttp;
  /** Includes the API version, for example https://api.wise.com/2026Q4. */
  apiUrl: string;
  limits: ProviderLimits;
  clock: Clock;
  diagnostics: DiagnosticsCollector;
  pause?: (ms: number) => Promise<void>;
}

export const STRONG_AUTH_MESSAGE =
  'Wise asks for strong customer authentication here. This app never signs requests, so it cannot continue.';

/** Wise's own words from a refused call, kept short. */
function wiseMessage(body: unknown): string | null {
  const answer = body as { errors?: { message?: unknown }[]; message?: unknown } | null | undefined;
  const said = answer?.errors?.[0]?.message ?? answer?.message;
  return typeof said === 'string' && said.trim() ? said.trim().slice(0, 300) : null;
}

/**
 * The only two writes this adapter can send, both only when the person asks for a draft: pricing a transfer and creating it unpaid.
 * Paying one (`POST /profiles/{id}/transfers/{id}/payments`) is not here on purpose: the person pays in Wise. `post()` refuses any
 * other path, and a test holds this list to exactly these two.
 */
export const WISE_WRITE_PATHS: readonly RegExp[] = [/^\/profiles\/\d+\/quotes$/, /^\/transfers$/];

export interface WiseRecipient {
  id: number;
  name: string;
  currency: string;
  summary: string | null;
}

export interface WiseQuote {
  quoteId: string;
  sourceMinor: number;
  sourceCurrency: string;
  targetMinor: number;
  targetCurrency: string;
  feeMinor: number | null;
  rate: string | null;
  expiresAt: string | null;
  /** False when Wise offered no price for paying from a balance: the price shown is for another way of paying. */
  fromBalance: boolean;
}

export interface WiseWaitingTransfer {
  id: number;
  status: string;
  targetMinor: number;
  targetCurrency: string;
  recipientId: number | null;
  /** The day Wise says it was created, YYYY-MM-DD. */
  createdOn: string | null;
}

/** Wise's most recent docs cap a page of recipients at 20; three pages keep the sheet quick at one request a second. */
const RECIPIENT_PAGE_SIZE = 20;
const RECIPIENT_PAGES = 3;

/**
 * Wise through a personal API token. Balances are read in the background like any bank, by two GETs: the profile list and each
 * profile's balances. There is no statement call (Wise requires strong customer authentication for statements outside US, CA, AU,
 * NZ, SG and MY, which this app does not implement), and `fetchTransactions` returns nothing without touching the network.
 *
 * When the person asks, it can also draft a transfer: read recipients, price it and create it unpaid. No money moves, because the
 * call that funds a transfer does not exist here. A refusal on those calls never marks the token as rejected: a token that may read
 * balances but not create transfers keeps working for balances.
 */
export class WiseProvider implements BankingProvider {
  readonly id: ProviderId;
  readonly mode: ProviderMode;
  readonly label: string;
  readonly limits: ProviderLimits;
  private readonly nextSlot = new Map<string, number>();

  constructor(private readonly deps: WiseDeps) {
    this.id = deps.id;
    this.mode = deps.mode;
    this.label = deps.label;
    this.limits = deps.limits;
  }

  private async pace(tokens: TokenSet): Promise<void> {
    const key = createHash('sha256').update(tokens.accessToken).digest('hex').slice(0, 16);
    const now = this.deps.clock.now().getTime();
    const at = Math.max(now, this.nextSlot.get(key) ?? now);
    this.nextSlot.set(key, at + this.limits.infoIntervalMs);
    if (at > now) {
      await (this.deps.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
        at - now,
      );
    }
  }

  /** The only way this adapter reaches the network: the token as a Bearer credential, paced, and recorded. */
  private async send(
    tokens: TokenSet,
    ctx: CallContext,
    endpoint: string,
    label: string,
    url: string,
    json?: unknown,
  ): Promise<HttpResult> {
    await this.pace(tokens);
    const started = performance.now();
    try {
      const response = await this.deps.http.request(ctx, {
        label,
        method: json === undefined ? 'GET' : 'POST',
        url,
        headers: { authorization: `Bearer ${tokens.accessToken}` },
        ...(json === undefined ? {} : { json }),
      });
      this.deps.diagnostics.recordCall(
        endpoint,
        response.status,
        Math.round(performance.now() - started),
      );
      return response;
    } catch (error) {
      this.deps.diagnostics.recordCall(endpoint, null, Math.round(performance.now() - started));
      throw error;
    }
  }

  private async get(
    tokens: TokenSet,
    ctx: CallContext,
    endpoint: 'profiles' | 'balances',
    label: string,
    url: string,
  ): Promise<unknown> {
    const response = await this.send(tokens, ctx, endpoint, label, url);
    if (!response.ok) this.fail(endpoint, response);
    try {
      return parseKeepingAmounts(response.text);
    } catch {
      return this.unreadable(endpoint);
    }
  }

  private fail(endpoint: string, response: HttpResult): never {
    const { status, headers } = response;
    if (status === 401) throw new TokenRejectedError('Wise does not accept the token');
    if (status === 403) {
      if (
        headers['x-2fa-approval'] !== undefined ||
        headers['x-2fa-approval-result'] !== undefined
      ) {
        this.deps.diagnostics.warn(
          `${endpoint}: strong customer authentication requested (403 with X-2FA headers)`,
        );
        // bank_unavailable: the sync worker then shows this message on Home, keeps the balances it has and tries again later.
        throw new AppError('bank_unavailable', 503, STRONG_AUTH_MESSAGE);
      }
      throw new TokenRejectedError('Wise does not let this token read that');
    }
    if (status === 429) {
      const retry = Number(headers['retry-after']);
      throw new AppError('rate_limited', 429, 'Wise asked for fewer requests. Waiting.', {
        retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : 5,
      });
    }
    if (status >= 500) throw new AppError('bank_unavailable', 503, 'Wise is not responding.');
    this.deps.diagnostics.warn(`${endpoint}: unexpected status ${status}`);
    throw new AppError(
      'provider_error',
      502,
      `Wise answered with an unexpected status (${status}).`,
    );
  }

  /** Why Wise refused a draft call, in its own words: the screens show this. A refusal here never touches the connection's state. */
  private draftFail(endpoint: string, response: HttpResult): never {
    const { status, headers } = response;
    if (status === 401) throw new TokenRejectedError('Wise does not accept the token');
    if (status === 429) {
      const retry = Number(headers['retry-after']);
      throw new AppError('rate_limited', 429, 'Wise asked for fewer requests. Try again shortly.', {
        retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : 5,
      });
    }
    if (status >= 500) throw new AppError('bank_unavailable', 503, 'Wise is not responding.');
    this.deps.diagnostics.warn(`${endpoint}: refused with status ${status}`);
    if (status === 403) {
      if (
        headers['x-2fa-approval'] !== undefined ||
        headers['x-2fa-approval-result'] !== undefined
      ) {
        throw new AppError(
          'provider_error',
          502,
          'Wise asks for strong customer authentication for this. Ledger Lens never signs requests, so make this transfer in Wise itself.',
        );
      }
      throw new AppError(
        'provider_error',
        502,
        'Wise does not let this token do that. Its permission may be read-only: make this transfer in Wise itself, or issue a token that allows it. Your balances keep working.',
      );
    }
    const said = wiseMessage(response.body);
    throw new AppError(
      'provider_error',
      502,
      said
        ? `Wise refused this: ${said}`
        : `Wise refused this (status ${status}). You can make this transfer in Wise itself.`,
    );
  }

  /** The only write: a POST to one of `WISE_WRITE_PATHS`, nothing else can leave this class. */
  private async post(
    tokens: TokenSet,
    ctx: CallContext,
    endpoint: string,
    label: string,
    path: string,
    json: unknown,
  ): Promise<HttpResult> {
    if (!WISE_WRITE_PATHS.some((allowed) => allowed.test(path))) {
      throw new AppError('forbidden', 403, 'Ledger Lens does not send that to Wise.');
    }
    return this.send(tokens, ctx, endpoint, label, `${this.deps.apiUrl}${path}`, json);
  }

  private parseOrUnreadable(endpoint: string, response: HttpResult): unknown {
    try {
      return parseKeepingAmounts(response.text);
    } catch {
      return this.unreadable(endpoint);
    }
  }

  private toMinor(endpoint: string, value: string, currency: string): number {
    const minor = decimalToMinor(value, currencyExponent(currency));
    return minor === null ? this.unreadable(endpoint) : minor;
  }

  /** The saved recipients of one profile. `more` says there were others past the pages read. */
  async listRecipients(
    tokens: TokenSet,
    ctx: CallContext,
    profileId: number,
  ): Promise<{ recipients: WiseRecipient[]; more: boolean }> {
    const recipients: WiseRecipient[] = [];
    let seek: unknown = null;
    for (let page = 0; page < RECIPIENT_PAGES; page += 1) {
      const query = new URLSearchParams({
        profileId: String(profileId),
        size: String(RECIPIENT_PAGE_SIZE),
      });
      if (typeof seek === 'number') query.set('seekPosition', String(seek));
      const response = await this.send(
        tokens,
        ctx,
        'recipients',
        'List recipients',
        `${this.deps.apiUrl}/accounts?${query.toString()}`,
      );
      if (!response.ok) this.draftFail('recipients', response);
      const raw = this.parseOrUnreadable('recipients', response) as {
        content?: unknown;
        seekPositionForNext?: unknown;
      } | null;
      if (!Array.isArray(raw?.content)) this.unreadable('recipients');
      const content = raw.content as unknown[];
      this.deps.diagnostics.observeRows('recipients', content, RECIPIENT_FIELDS);
      const { items, failures } = parseRows(RecipientDto, content);
      for (const failure of failures)
        this.deps.diagnostics.warn(`recipients: skipped a recipient (${failure})`);
      for (const item of items) {
        if (item.active === false) continue;
        recipients.push({
          id: item.id,
          name: item.name?.fullName?.trim() || item.accountHolderName?.trim() || 'Recipient',
          currency: item.currency.toUpperCase(),
          summary: item.accountSummary?.trim() || null,
        });
      }
      seek = raw.seekPositionForNext;
      if (content.length < RECIPIENT_PAGE_SIZE || typeof seek !== 'number') {
        return { recipients, more: false };
      }
    }
    return { recipients, more: true };
  }

  /** Transfers waiting for payment on one profile. A created transfer has this status until it is paid in Wise. */
  async listWaiting(
    tokens: TokenSet,
    ctx: CallContext,
    profileId: number,
  ): Promise<WiseWaitingTransfer[]> {
    const query = new URLSearchParams({
      profile: String(profileId),
      status: 'incoming_payment_waiting',
      limit: '20',
    });
    const response = await this.send(
      tokens,
      ctx,
      'transfers',
      'List transfers waiting for payment',
      `${this.deps.apiUrl}/transfers?${query.toString()}`,
    );
    if (!response.ok) this.draftFail('transfers', response);
    const raw = this.parseOrUnreadable('transfers', response);
    if (!Array.isArray(raw)) this.unreadable('transfers');
    this.deps.diagnostics.observeRows('transfers', raw as unknown[], TRANSFER_FIELDS);
    const { items, failures } = parseRows(TransferDto, raw as unknown[]);
    for (const failure of failures)
      this.deps.diagnostics.warn(`transfers: skipped a transfer (${failure})`);
    return items.map((item) => {
      const currency = item.targetCurrency.toUpperCase();
      return {
        id: item.id,
        status: item.status,
        targetMinor: this.toMinor('transfers', item.targetValue, currency),
        targetCurrency: currency,
        recipientId: item.targetAccount ?? null,
        createdOn: /^\d{4}-\d{2}-\d{2}/.exec(item.created ?? '')?.[0] ?? null,
      };
    });
  }

  /** Prices a transfer. Nothing is created: an unused quote lapses by itself. */
  async quoteDraft(
    tokens: TokenSet,
    ctx: CallContext,
    input: {
      profileId: number;
      recipientId: number;
      sourceCurrency: string;
      targetCurrency: string;
      sourceMinor: number;
    },
  ): Promise<WiseQuote> {
    const response = await this.post(
      tokens,
      ctx,
      'quotes',
      'Price a transfer',
      `/profiles/${input.profileId}/quotes`,
      {
        sourceCurrency: input.sourceCurrency,
        targetCurrency: input.targetCurrency,
        sourceAmount: Number(minorToDecimalString(input.sourceMinor, input.sourceCurrency)),
        targetAmount: null,
        targetAccount: input.recipientId,
        preferredPayIn: 'BALANCE',
      },
    );
    if (!response.ok) this.draftFail('quotes', response);
    const raw = this.parseOrUnreadable('quotes', response);
    this.deps.diagnostics.observeRows('quotes', [raw], QUOTE_FIELDS);
    const parsed = QuoteDto.safeParse(raw);
    if (!parsed.success) return this.unreadable('quotes');
    const quote = parsed.data;
    const open = quote.paymentOptions.filter((o) => o.disabled !== true);
    const fromBalance = open.filter((o) => o.payIn === 'BALANCE');
    const option =
      fromBalance.find((o) => o.payOut === quote.payOut) ?? fromBalance[0] ?? open[0] ?? null;
    if (!option) {
      const reason = quote.paymentOptions.find((o) => o.disabledReason?.message)?.disabledReason;
      throw new AppError(
        'provider_error',
        502,
        reason?.message
          ? `Wise refused this: ${reason.message}`
          : 'Wise offers no way to pay this transfer.',
      );
    }
    const source = quote.sourceCurrency.toUpperCase();
    const target = quote.targetCurrency.toUpperCase();
    const fee = option.price?.total.value.amount ?? option.fee?.total ?? null;
    return {
      quoteId: quote.id,
      sourceMinor: this.toMinor('quotes', option.sourceAmount, source),
      sourceCurrency: source,
      targetMinor: this.toMinor('quotes', option.targetAmount, target),
      targetCurrency: target,
      feeMinor: fee === null ? null : this.toMinor('quotes', fee, source),
      rate: quote.rate ?? null,
      expiresAt: quote.expirationTime ?? null,
      fromBalance: option.payIn === 'BALANCE',
    };
  }

  /**
   * Creates the transfer unpaid. `key` makes a repeat safe: Wise does not create a second transfer for the same one, so a timeout can be
   * retried. Once Wise has said yes the transfer exists, so an answer that cannot be read is still reported as created.
   */
  async createDraft(
    tokens: TokenSet,
    ctx: CallContext,
    input: { recipientId: number; quoteId: string; key: string; reference: string | null },
  ): Promise<{ transferId: number | null; status: string | null }> {
    const response = await this.post(
      tokens,
      ctx,
      'transfers',
      'Create a draft transfer',
      '/transfers',
      {
        targetAccount: input.recipientId,
        quoteUuid: input.quoteId,
        customerTransactionId: input.key,
        ...(input.reference ? { details: { reference: input.reference } } : {}),
      },
    );
    if (!response.ok) this.draftFail('transfers', response);
    const parsed = CreatedTransferDto.safeParse(response.body);
    if (!parsed.success) {
      this.deps.diagnostics.warn('transfers: created, but the answer had no id or status');
      return { transferId: null, status: null };
    }
    return { transferId: parsed.data.id, status: parsed.data.status };
  }

  private unreadable(endpoint: string): never {
    this.deps.diagnostics.warn(`${endpoint}: response was not the JSON shape the docs describe`);
    throw new AppError('provider_error', 502, 'Wise sent an answer this app could not read.');
  }

  private async read(tokens: TokenSet, ctx: CallContext): Promise<ProviderAccount[]> {
    const { diagnostics } = this.deps;
    const rawProfiles = await this.get(
      tokens,
      ctx,
      'profiles',
      'List profiles',
      `${this.deps.apiUrl}/profiles`,
    );
    if (!Array.isArray(rawProfiles)) this.unreadable('profiles');
    diagnostics.observeRows('profiles', rawProfiles as unknown[], PROFILE_FIELDS);
    const profiles = parseRows(ProfileDto, rawProfiles as unknown[]);
    for (const failure of profiles.failures)
      diagnostics.warn(`profiles: skipped a profile (${failure})`);
    const usable = profiles.items.filter((p) => p.currentState !== 'DEACTIVATED');

    const accounts: ProviderAccount[] = [];
    for (const profile of usable) {
      const raw = await this.get(
        tokens,
        ctx,
        'balances',
        'List balances',
        `${this.deps.apiUrl}/profiles/${profile.id}/balances?types=STANDARD,SAVINGS`,
      );
      if (!Array.isArray(raw)) this.unreadable('balances');
      diagnostics.observeRows('balances', raw as unknown[], BALANCE_FIELDS);
      const { items, failures } = parseRows(BalanceDto, raw as unknown[]);
      for (const failure of failures) diagnostics.warn(`balances: skipped a balance (${failure})`);
      for (const item of items) {
        if (item.visible === false) continue;
        const currency = item.currency.toUpperCase();
        const balanceMinor = decimalToMinor(item.amount.value, currencyExponent(currency));
        if (balanceMinor === null) {
          diagnostics.warn('balances: skipped a balance (amount.value: not a plain decimal)');
          continue;
        }
        const jar = item.type === 'SAVINGS';
        const business = profile.type === 'BUSINESS' && usable.length > 1 ? ' · business' : '';
        accounts.push({
          // The profile is part of the id because the balances call is made per profile.
          providerAccountId: `${profile.id}:${item.id}`,
          kind: jar ? 'jar' : 'card',
          cardType: jar ? 'jar' : 'wise',
          name: (jar ? item.name?.trim() || `${currency} jar` : `${currency} balance`) + business,
          currency,
          last4: null,
          creditLimitMinor: 0,
          balanceMinor,
          goalMinor: null,
          sort: accounts.length,
        });
      }
    }
    return accounts;
  }

  async connect(
    input: { token: string },
    ctx: CallContext,
  ): Promise<{ tokens: TokenSet; accounts: ProviderAccount[] }> {
    const tokens: TokenSet = { accessToken: normaliseToken(input.token) };
    try {
      return { tokens, accounts: await this.read(tokens, ctx) };
    } catch (error) {
      if (error instanceof TokenRejectedError) {
        throw new AppError('validation_failed', 400, 'Wise did not accept this token.', {
          errors: [
            {
              path: 'token',
              message:
                'Wise does not recognise this token. Copy all of it, or create a new one in Wise.',
            },
          ],
          cause: error,
        });
      }
      throw error;
    }
  }

  fetchAccounts(tokens: TokenSet, ctx: CallContext): Promise<ProviderAccount[]> {
    return this.read(tokens, ctx);
  }

  /** Never touches the network: statements need strong authentication this app does not implement. */
  fetchTransactions(
    _tokens: TokenSet,
    _account: AccountRef,
    _window: TransactionWindow,
    _ctx: CallContext,
  ): Promise<ProviderTransaction[]> {
    return Promise.resolve([]);
  }

  fetchRates(): Promise<RatePair[]> {
    return Promise.reject(new AppError('provider_not_available', 404, 'Wise rates are not used.'));
  }

  revoke(): Promise<void> {
    // A personal token is revoked in Wise (Your account > API tokens), not through the API.
    return Promise.resolve();
  }
}
