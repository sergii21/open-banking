import { createHash } from 'node:crypto';
import { currencyExponent, type ProviderId, type ProviderMode } from '@ledger-lens/contracts';
import type { Clock } from '../../clock';
import { type Calendar } from '../../domain/calendar';
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
import type { HttpRequest, HttpResult, ProviderHttp } from '../transport';
import {
  BALANCE_FIELDS,
  BalanceDto,
  SETTINGS_FIELDS,
  SettingsDto,
  TRANSACTION_FIELDS,
  TransactionDto,
  parseLocalDateTime,
  type TransactionItem,
} from './dto';

export interface PrivatBankDeps {
  id: ProviderId;
  mode: ProviderMode;
  label: string;
  http: ProviderHttp;
  /** Origin only, for example https://acp.privatbank.ua. */
  apiUrl: string;
  limits: ProviderLimits;
  calendar: Calendar;
  clock: Clock;
  diagnostics: DiagnosticsCollector;
  /** Waits. Tests replace it so the test clock moves instead of the wall clock. */
  pause?: (ms: number) => Promise<void>;
}

/** Rows asked for per request: the document recommends at most 100 (the maximum is 500). */
const PAGE_SIZE = '100';
/** A window of a month holds a few hundred items at most; this only stops a server that never says "no more pages". */
const MAX_PAGES = 60;

export const ROUTINE_MESSAGE =
  'PrivatBank is doing its daily routine and is not answering statement requests. Trying again shortly.';

const last4 = (value: string | null | undefined): string | null => {
  const digits = value?.replace(/\D/g, '') ?? '';
  return digits.length >= 4 ? digits.slice(-4) : null;
};

/** `2026-11-03` to `03-11-2026`, the way the statements endpoints want dates. */
const ddmmyyyy = (day: string): string =>
  `${day.slice(8, 10)}-${day.slice(5, 7)}-${day.slice(0, 4)}`;

const clean = (value: string | null | undefined): string | null => {
  const squeezed = value?.replace(/\s+/g, ' ').trim();
  return squeezed ? squeezed : null;
};

interface ErrorInfo {
  code: string | undefined;
  message: string | undefined;
}

/** `{"status":"ERROR","code":"VE014","message":"Bad token format"}` is how this service reports a problem. */
function errorInfo(body: unknown): ErrorInfo {
  if (typeof body !== 'object' || body === null) return { code: undefined, message: undefined };
  const record = body as Record<string, unknown>;
  // The same code arrives twice, as `code` and as `appErrorCode`.
  const code = record['code'] ?? record['appErrorCode'];
  return {
    code: typeof code === 'string' ? code : undefined,
    message: typeof record['message'] === 'string' ? record['message'] : undefined,
  };
}

/**
 * PrivatBank, "Autoclient" API for business and ФОП accounts. The person creates an integration key in Privat24 for Business
 * (and restricts it to balances and transactions); everything here reads that business's own accounts. Personal cards have no
 * API any more (it was closed in 2022): those come in through a statement file.
 *
 * The service asks for no more than one request a second. Reading a window can take several requests (rows come in pages),
 * so the adapter paces itself between requests; the sync worker waits `limits.statementIntervalMs` after a whole step on top.
 */
export class PrivatBankProvider implements BankingProvider {
  readonly id: ProviderId;
  readonly mode: ProviderMode;
  readonly label: string;
  readonly limits: ProviderLimits;
  /** When each token's next request may start, so two calls for one token are never closer than the limit. In memory only. */
  private readonly nextSlot = new Map<string, number>();

  constructor(private readonly deps: PrivatBankDeps) {
    this.id = deps.id;
    this.mode = deps.mode;
    this.label = deps.label;
    this.limits = deps.limits;
  }

  // ----------------------------------------------------------------------------- plumbing

  private headers(tokens: TokenSet): Record<string, string> {
    // utf8 is named because the service assumes cp1251 when the charset is missing.
    return { token: tokens.accessToken, 'content-type': 'application/json;charset=utf8' };
  }

  private url(path: string, query: Record<string, string> = {}): string {
    const url = new URL(`${this.deps.apiUrl}/api/statements/${path}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    return url.toString();
  }

  /**
   * Waits until a request for this token is allowed. The slot is reserved before waiting, so callers that arrive together (the
   * loader of one session, the connect of another, both with the same key) queue one behind the other instead of all waking up
   * at the same moment.
   */
  private async pace(tokens: TokenSet): Promise<void> {
    const key = createHash('sha256').update(tokens.accessToken).digest('hex').slice(0, 16);
    const now = this.deps.clock.now().getTime();
    const at = Math.max(now, this.nextSlot.get(key) ?? now);
    this.nextSlot.set(key, at + this.limits.statementIntervalMs);
    if (at > now) {
      await (this.deps.pause ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
        at - now,
      );
    }
  }

  private async call(
    tokens: TokenSet,
    ctx: CallContext,
    endpoint: string,
    spec: Omit<HttpRequest, 'method' | 'headers'>,
  ): Promise<HttpResult> {
    await this.pace(tokens);
    const started = performance.now();
    try {
      const result = await this.deps.http.request(ctx, {
        ...spec,
        method: 'GET',
        headers: this.headers(tokens),
      });
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

  private fail(
    endpoint: string,
    status: number,
    body: unknown,
    headers: Record<string, string>,
  ): never {
    const info = errorInfo(body);
    if (status === 401 || status === 403 || info.code === 'VE014') {
      throw new TokenRejectedError('PrivatBank does not accept the token');
    }
    if (status === 429) {
      const retry = Number(headers['retry-after']);
      throw new AppError(
        'rate_limited',
        429,
        'PrivatBank asks for one request a second. Waiting.',
        {
          retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? Math.ceil(retry) : 5,
        },
      );
    }
    if (status >= 500) {
      throw new AppError('bank_unavailable', 503, 'PrivatBank is not responding.');
    }
    if (/груп|group/i.test(info.message ?? '')) {
      throw new AppError(
        'provider_error',
        502,
        'This key belongs to a group account (група ПП), which Ledger Lens does not read yet.',
      );
    }
    // The code is a short identifier such as VE014, not data; anything else is left out.
    const code = info.code && /^[A-Za-z0-9_]{1,16}$/.test(info.code) ? `, ${info.code}` : '';
    this.deps.diagnostics.warn(`${endpoint}: unexpected status ${status}${code}`);
    throw new AppError(
      'provider_error',
      502,
      `PrivatBank answered with an unexpected status (${status}${code}).`,
    );
  }

  private unreadable(endpoint: string): never {
    this.deps.diagnostics.warn(`${endpoint}: response was not the JSON shape the docs describe`);
    throw new AppError('provider_error', 502, 'PrivatBank sent an answer this app could not read.');
  }

  /** The JSON object of an answer, after the HTTP status and the service's own `status: ERROR` have been dealt with. */
  private envelope(endpoint: string, response: HttpResult): Record<string, unknown> {
    if (!response.ok) this.fail(endpoint, response.status, response.body, response.headers);
    const body = response.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) this.unreadable(endpoint);
    const record = body as Record<string, unknown>;
    if (record['status'] === 'ERROR')
      this.fail(endpoint, response.status, record, response.headers);
    return record;
  }

  /** Reads every page of a list endpoint (`exist_next_page` / `next_page_id` / `followId`). */
  private async pages(
    tokens: TokenSet,
    ctx: CallContext,
    path: string,
    label: string,
    query: Record<string, string>,
    listKey: 'balances' | 'transactions',
    known: ReadonlySet<string>,
  ): Promise<unknown[]> {
    const rows: unknown[] = [];
    let followId: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await this.call(tokens, ctx, path, {
        label,
        url: this.url(path, { ...query, ...(followId ? { followId } : {}) }),
      });
      const body = this.envelope(path, response);
      const list = body[listKey];
      if (!Array.isArray(list)) this.unreadable(path);
      this.deps.diagnostics.observeRows(path, list as unknown[], known);
      rows.push(...(list as unknown[]));
      const next = body['next_page_id'];
      if (
        body['exist_next_page'] === true &&
        typeof next === 'string' &&
        next &&
        next !== followId
      ) {
        followId = next;
      } else {
        return rows;
      }
    }
    this.deps.diagnostics.warn(`${path}: stopped after ${MAX_PAGES} pages`);
    return rows;
  }

  /** While the bank runs its daily routine its answers may be errors: say so instead of reporting a broken adapter. */
  private async explainOutage<T>(
    tokens: TokenSet,
    ctx: CallContext,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (
        error instanceof AppError &&
        (error.code === 'bank_unavailable' || error.code === 'provider_error')
      ) {
        try {
          await this.assertOpen(tokens, ctx);
        } catch (routine) {
          if (routine instanceof AppError && routine.message === ROUTINE_MESSAGE) throw routine;
        }
      }
      throw error;
    }
  }

  // ----------------------------------------------------------------------------- connecting

  /** `settings` says whether the bank is in its daily routine (`phase` other than WRK, or `work_balance` Y). */
  private async assertOpen(tokens: TokenSet, ctx: CallContext): Promise<void> {
    const response = await this.call(tokens, ctx, 'settings', {
      label: 'Get server dates',
      url: this.url('settings'),
    });
    const body = this.envelope('settings', response);
    const settings = body['settings'];
    if (typeof settings !== 'object' || settings === null) this.unreadable('settings');
    this.deps.diagnostics.observeRows('settings', [settings], SETTINGS_FIELDS);
    const parsed = SettingsDto.safeParse(settings);
    if (!parsed.success) this.unreadable('settings');
    const { phase, work_balance: working } = parsed.data;
    if ((phase && phase !== 'WRK') || working === 'Y') {
      throw new AppError('bank_unavailable', 503, ROUTINE_MESSAGE);
    }
  }

  async connect(
    input: { token: string },
    ctx: CallContext,
  ): Promise<{ tokens: TokenSet; accounts: ProviderAccount[] }> {
    const tokens: TokenSet = { accessToken: normaliseToken(input.token) };
    try {
      await this.assertOpen(tokens, ctx);
      return { tokens, accounts: await this.listAccounts(tokens, ctx) };
    } catch (error) {
      if (error instanceof TokenRejectedError) {
        throw new AppError('validation_failed', 400, 'PrivatBank did not accept this token.', {
          errors: [
            {
              path: 'token',
              message:
                'PrivatBank does not recognise this token. Copy all of it, or create a new one in Privat24 for Business.',
            },
          ],
          cause: error,
        });
      }
      throw error;
    }
  }

  revoke(): Promise<void> {
    // The key is withdrawn in Privat24 for Business (its "Підключити API" list), not through the API.
    return Promise.resolve();
  }

  // ----------------------------------------------------------------------------- accounts

  private async listAccounts(tokens: TokenSet, ctx: CallContext): Promise<ProviderAccount[]> {
    const raw = await this.pages(
      tokens,
      ctx,
      'balance/interim',
      'List balances',
      { limit: PAGE_SIZE },
      'balances',
      BALANCE_FIELDS,
    );
    const { items, failures } = parseRows(BalanceDto, raw);
    for (const failure of failures) {
      this.deps.diagnostics.warn(`balance/interim: skipped an account (${failure})`);
    }
    if (raw.length > 0 && items.length === 0) this.unreadable('balance/interim');

    const seen = new Set<string>();
    const rows: ProviderAccount[] = [];
    for (const item of items) {
      if (seen.has(item.acc)) continue;
      seen.add(item.acc);
      const currency = item.currency.toUpperCase();
      const balanceMinor = decimalToMinor(item.balanceOut, currencyExponent(currency));
      if (balanceMinor === null) {
        this.deps.diagnostics.warn(
          'balance/interim: skipped an account (balanceOut: not a number)',
        );
        continue;
      }
      rows.push({
        // The only name the bank accepts for an account in later requests is its IBAN; it is kept for that and shown as four digits.
        providerAccountId: item.acc,
        kind: 'card',
        cardType: 'business',
        name: currency === 'UAH' ? 'Business account' : `Business account ${currency}`,
        currency,
        last4: last4(item.acc),
        creditLimitMinor: 0,
        balanceMinor,
        goalMinor: null,
        sort: 0,
      });
    }
    return rows
      .map((row, index) => ({ row, index }))
      .sort(
        (a, b) =>
          (a.row.currency === 'UAH' ? 0 : 1) - (b.row.currency === 'UAH' ? 0 : 1) ||
          a.row.currency.localeCompare(b.row.currency) ||
          a.index - b.index,
      )
      .map(({ row }, sort) => ({ ...row, sort }));
  }

  fetchAccounts(tokens: TokenSet, ctx: CallContext): Promise<ProviderAccount[]> {
    return this.explainOutage(tokens, ctx, () => this.listAccounts(tokens, ctx));
  }

  // ----------------------------------------------------------------------------- transactions

  async fetchTransactions(
    tokens: TokenSet,
    account: AccountRef,
    window: TransactionWindow,
    ctx: CallContext,
  ): Promise<ProviderTransaction[]> {
    const { calendar, clock } = this.deps;
    const today = calendar.today(clock.now());
    const to = window.to > today ? today : window.to;
    if (to < window.from) return [];
    return this.explainOutage(tokens, ctx, async () => {
      const acc = account.providerAccountId;
      const raw = await this.pages(
        tokens,
        ctx,
        'transactions',
        'List transactions',
        { acc, startDate: ddmmyyyy(window.from), endDate: ddmmyyyy(to), limit: PAGE_SIZE },
        'transactions',
        TRANSACTION_FIELDS,
      );
      // The interval statement may stop at the last closed operating day; today's items (and holds) come from the interim one.
      if (to >= today) {
        raw.push(
          ...(await this.pages(
            tokens,
            ctx,
            'transactions/interim',
            'List transactions (today)',
            { acc, limit: PAGE_SIZE },
            'transactions',
            TRANSACTION_FIELDS,
          )),
        );
      }
      return this.mapAll(raw, window.from, to);
    });
  }

  private mapAll(raw: readonly unknown[], from: string, to: string): ProviderTransaction[] {
    const { diagnostics, calendar } = this.deps;
    const { items, failures } = parseRows(TransactionDto, raw);
    for (const failure of failures) diagnostics.warn(`transactions: skipped a row (${failure})`);
    const fromTs = calendar.dayStart(from);
    const toTs = calendar.dayEnd(to);
    // The interim answer repeats rows the interval one already sent, and is the newer of the two: the later row wins.
    const byId = new Map<string, ProviderTransaction>();
    for (const item of items) {
      const row = this.mapItem(item);
      if (row && row.ts >= fromTs && row.ts <= toTs) byId.set(row.providerTxnId, row);
    }
    return [...byId.values()].sort(
      (a, b) => b.ts - a.ts || (a.providerTxnId < b.providerTxnId ? 1 : -1),
    );
  }

  /** Null for an item that is not money that moved (reversed, rejected, not real) or cannot be read; each is counted by reason. */
  private mapItem(item: TransactionItem): ProviderTransaction | null {
    const { diagnostics, calendar } = this.deps;
    const state = item.PR_PR?.trim().toLowerCase();
    if (state === 't') return this.skip('transactions: skipped a reversed item (PR_PR t)');
    if (state === 'n') return this.skip('transactions: skipped a rejected item (PR_PR n)');
    if (item.FL_REAL?.trim().toLowerCase() === 'i') {
      return this.skip('transactions: skipped a not-real item (FL_REAL i)');
    }
    if (state && state !== 'p' && state !== 'r') {
      diagnostics.warn(
        `transactions: unknown PR_PR value ${state.replace(/[^a-z0-9]/g, '').slice(0, 4)}`,
      );
    }

    const type = item.TRANTYPE?.trim().toUpperCase();
    if (type !== 'D' && type !== 'C')
      return this.skip('transactions: skipped a row without TRANTYPE D or C');
    const currency = item.CCY.toUpperCase();
    const magnitude = decimalToMinor(item.SUM, currencyExponent(currency));
    if (magnitude === null) return this.skip('transactions: skipped a row (SUM: not a number)');

    const at =
      parseLocalDateTime(item.DATE_TIME_DAT_OD_TIM_P) ??
      parseLocalDateTime(item.DAT_OD, item.TIM_P) ??
      parseLocalDateTime(item.DAT_KL, item.TIM_P);
    if (!at) return this.skip('transactions: skipped a row without a readable date');

    // "REF+REFN" is the document's own uniqueness rule; a separator keeps REF 12 + REFN 3 apart from REF 1 + REFN 23.
    const ref = clean(item.REF);
    const refn = clean(item.REFN);
    const id =
      ref && refn ? `${ref}:${refn}` : (clean(item.ID) ?? clean(item.TECHNICAL_TRANSACTION_ID));
    if (!id) return this.skip('transactions: skipped a row without REF, REFN or ID');

    const counterparty = clean(item.AUT_CNTR_NAM);
    return {
      providerTxnId: id,
      ts: calendar.toInstant(at.day, at.hour, at.minute, at.second),
      status: state === 'p' ? 'pending' : 'booked',
      amountMinor: type === 'D' ? -magnitude : magnitude,
      currency,
      description: clean(item.OSND) ?? counterparty ?? 'Transaction',
      counterparty,
      mcc: null,
      cashbackMinor: 0,
      commissionMinor: 0,
      comment: null,
      receiptId: null,
      balanceAfterMinor: null,
    };
  }

  private skip(reason: string): null {
    this.deps.diagnostics.warn(reason);
    return null;
  }

  // ----------------------------------------------------------------------------- rates

  fetchRates(): Promise<RatePair[]> {
    // Hryvnia rates come from monobank's public list for every bank (see the registry); this adapter has none of its own.
    return Promise.reject(
      new AppError('provider_not_available', 404, 'PrivatBank rates are not used.'),
    );
  }
}
