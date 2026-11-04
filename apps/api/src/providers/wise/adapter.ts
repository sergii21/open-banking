import { createHash } from 'node:crypto';
import { currencyExponent, type ProviderId, type ProviderMode } from '@ledger-lens/contracts';
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
import { BALANCE_FIELDS, BalanceDto, PROFILE_FIELDS, ProfileDto, parseKeepingAmounts } from './dto';

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
  'Wise asks for strong customer authentication here. This app only reads balances and never signs requests, so it cannot continue.';

/**
 * Wise through a personal API token, for balances only. The only network calls this class can make are two GETs, `get()` below:
 * the profile list and each profile's balances. There is no statement call (Wise requires strong customer authentication for
 * statements outside US, CA, AU, NZ, SG and MY, which this app does not implement), and no payment, transfer or other write:
 * nothing here can build a request with another method or path. `fetchTransactions` returns nothing without touching the network.
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

  /** The only way this adapter reaches the network: a GET with the token as a Bearer credential. */
  private async get(
    tokens: TokenSet,
    ctx: CallContext,
    endpoint: 'profiles' | 'balances',
    label: string,
    url: string,
  ): Promise<unknown> {
    await this.pace(tokens);
    const started = performance.now();
    let response: HttpResult;
    try {
      response = await this.deps.http.request(ctx, {
        label,
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      });
    } catch (error) {
      this.deps.diagnostics.recordCall(endpoint, null, Math.round(performance.now() - started));
      throw error;
    }
    this.deps.diagnostics.recordCall(
      endpoint,
      response.status,
      Math.round(performance.now() - started),
    );
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
