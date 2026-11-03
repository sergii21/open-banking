import type { Clock } from '../../../clock';
import { type Calendar } from '../../../domain/calendar';
import { minorToDecimalString } from '@ledger-lens/contracts';
import type { Transport } from '../../transport';
import { buildBusinessDataset, dmy, pad2, type FakeDataset, type FakeItem } from './dataset';

/** The only key the fake accepts. It is not a secret: it opens a fake. */
export const FAKE_PRIVAT_TOKEN = 'privat-autoclient-fake-token-not-a-real-bank';

export interface FakeAutoclientOptions {
  clock: Clock;
  calendar: Calendar;
  token?: string;
  /** Answer 429 to a request closer than this to the previous one (PrivatBank asks for at most one a second). Null: no limit. */
  intervalMs?: number | null;
  /** Pretend the network takes this long. */
  latencyMs?: number;
  seed?: number;
  historyDays?: number;
}

export interface FakeReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const error = (status: number, message: string, code?: string): FakeReply => ({
  status,
  body: {
    status: 'ERROR',
    ...(code ? { code } : {}),
    message,
    requestId: 'fake',
    ...(code ? { appErrorCode: code } : {}),
  },
});

/**
 * A stand-in for acp.privatbank.ua's statements API: the same paths, headers, paging and field names as the published
 * document (Autoclient v3.0.0), with a made-up business's data. What the document does not say is invented here and marked:
 * the body of a 429 and of a well-formed but unknown key. The in-process transport serves tests; `server.ts` serves it over
 * HTTP for browser runs. It enforces the one-request-a-second pace, the page size, the interim/interval split and the
 * bank's daily routine (`routine`), so an adapter that ignores any of them fails here the way it would on the real thing.
 */
export class FakeAutoclient {
  /** Everything answers 503 while this is on (an outage). */
  down = false;
  /** The bank's daily routine: `settings` says so (`phase` other than WRK, `work_balance` Y) and statements may fail. */
  routine = false;
  private data: FakeDataset | null = null;
  private dataDay = '';
  private lastCall: number | undefined;
  /** Every request, for tests that check what the adapter sent. */
  readonly requests: {
    path: string;
    query: string;
    headers: Record<string, string>;
    at: number;
  }[] = [];

  constructor(private readonly options: FakeAutoclientOptions) {}

  get token(): string {
    return this.options.token ?? FAKE_PRIVAT_TOKEN;
  }

  setInterval(intervalMs: number | null): void {
    this.options.intervalMs = intervalMs;
  }

  private dataset(): FakeDataset {
    const now = this.options.clock.now();
    const day = this.options.calendar.today(now);
    if (!this.data || this.dataDay !== day) {
      this.data = buildBusinessDataset(
        now,
        this.options.calendar,
        this.options.seed,
        this.options.historyDays,
      );
      this.dataDay = day;
    }
    return this.data;
  }

  private raw(item: FakeItem, data: FakeDataset): Record<string, string> {
    const account = data.accounts.find((a) => a.acc === item.acc);
    const time = `${pad2(item.hour)}:${pad2(item.minute)}`;
    const sum = minorToDecimalString(item.sumMinor, item.currency);
    return {
      AUT_MY_CRF: '3145128800',
      AUT_MY_MFO: '305299',
      AUT_MY_ACC: account?.short ?? '',
      AUT_MY_NAM: 'ФОП Тестовий Тарас Тарасович',
      AUT_MY_MFO_NAME: 'АТ КБ "ПРИВАТБАНК"',
      AUT_MY_MFO_CITY: 'Київ',
      AUT_CNTR_CRF: item.counterpartyCode,
      AUT_CNTR_MFO: '305299',
      AUT_CNTR_ACC: item.counterpartyAcc,
      AUT_CNTR_NAM: item.counterparty,
      AUT_CNTR_MFO_NAME: 'АТ КБ "ПРИВАТБАНК"',
      AUT_CNTR_MFO_CITY: 'Київ',
      CCY: item.currency,
      FL_REAL: item.real,
      PR_PR: item.state,
      DOC_TYP: 'm',
      NUM_DOC: `K${item.id.slice(-6)}`,
      DAT_KL: dmy(item.day),
      DAT_OD: dmy(item.day),
      OSND: item.purpose,
      SUM: sum.replace('-', ''),
      SUM_E:
        item.currency === 'UAH'
          ? sum.replace('-', '')
          : minorToDecimalString(Math.round(item.sumMinor * 41.4), 'UAH'),
      REF: item.ref,
      REFN: '1',
      TIM_P: time,
      DATE_TIME_DAT_OD_TIM_P: `${dmy(item.day)} ${time}:00`,
      ID: item.id,
      TRANTYPE: item.type,
      DLR: `J${item.id}`,
      TECHNICAL_TRANSACTION_ID: `${item.id}_online`,
      ...(item.ultimate
        ? {
            UETR: '00000000-0000-4000-8000-000000000000',
            ULTMT: 'Y',
            PAYER_ULTMT_NCEO: '',
            PAYER_ULTMT_DOCUMENT: 'КК123456',
            PAYER_ULTMT_NAME: 'Фізична особа (вигадана)',
            PAYER_ULTMT_COUNTRY_CODE: 'UA',
            RECIPIENT_ULTMT_NCEO: '',
            RECIPIENT_ULTMT_DOCUMENT: '',
            RECIPIENT_ULTMT_NAME: '',
            RECIPIENT_ULTMT_COUNTRY_CODE: '',
          }
        : {}),
    };
  }

  private page<T>(
    rows: T[],
    query: URLSearchParams,
    maxLimit: number,
    key: string,
    type: string,
  ): FakeReply {
    const requested = query.get('limit');
    const limit = requested === null ? 20 : Number(requested);
    if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
      return error(400, `limit must be between 1 and ${maxLimit}`);
    }
    // The cursor is opaque to the client, as in the document ("620699370_online").
    const follow = query.get('followId');
    const offset = follow === null ? 0 : Number(follow.split('_')[0]);
    if (!Number.isInteger(offset) || offset < 0) return error(400, 'followId is not valid');
    const slice = rows.slice(offset, offset + limit);
    const more = offset + limit < rows.length;
    return {
      status: 200,
      body: {
        status: 'SUCCESS',
        type,
        exist_next_page: more,
        ...(more ? { next_page_id: `${offset + limit}_online` } : {}),
        [key]: slice,
      },
    };
  }

  private throttled(): FakeReply | null {
    const gap = this.options.intervalMs;
    if (!gap) return null;
    const now = this.options.clock.now().getTime();
    if (this.lastCall !== undefined && now - this.lastCall < gap) {
      // The document does not say what a request that comes too soon gets; this is a guess in the document's own shape.
      return { ...error(429, 'Too many requests'), headers: { 'retry-after': '1' } };
    }
    this.lastCall = now;
    return null;
  }

  handle(
    method: string,
    pathname: string,
    query: URLSearchParams,
    headers: Record<string, string>,
  ): FakeReply {
    this.requests.push({
      path: pathname,
      query: query.toString(),
      headers,
      at: this.options.clock.now().getTime(),
    });
    if (method !== 'GET') return error(405, 'Method not allowed');
    if (!pathname.startsWith('/api/statements/')) return error(404, 'Not found');

    const token = headers['token'];
    // The real service answers 400 VE014 "Bad token format" to a short junk key; a long well-formed unknown key is a guess (401).
    if (!token || !/^[A-Za-z0-9_-]{16,}$/.test(token))
      return error(400, 'Bad token format', 'VE014');
    if (token !== this.token) return error(401, 'Token is not valid');
    if (!/charset=utf-?8/i.test(headers['content-type'] ?? '')) {
      return error(400, 'Send Content-Type: application/json;charset=utf8');
    }
    if (!headers['user-agent']) return error(400, 'User-Agent is required');
    if (this.down) return error(503, 'Service unavailable');
    const limited = this.throttled();
    if (limited) return limited;

    const now = this.options.clock.now();
    const data = this.dataset();
    const today = this.options.calendar.today(now);
    const rest = pathname.slice('/api/statements/'.length);

    if (rest === 'settings') {
      return {
        status: 200,
        body: {
          status: 'SUCCESS',
          type: 'settings',
          settings: {
            phase: this.routine ? 'EOD' : 'WRK',
            dates_without_oper_day: [],
            today: `${dmy(today)} 00:00:00`,
            lastday: `${dmy(data.lastDay)} 00:00:00`,
            work_balance: this.routine ? 'Y' : 'N',
            server_date_time: `${dmy(today)} ${pad2(now.getUTCHours() + 2)}:${pad2(now.getUTCMinutes())}:00`,
            date_final_statement: `${dmy(data.lastDay)} 00:00:00`,
          },
        },
      };
    }
    // During the routine the service "may answer with errors".
    if (this.routine) return error(500, 'Daily routine in progress');

    const acc = query.get('acc');
    const accounts = data.accounts.filter((a) => !acc || a.acc === acc);
    if (acc && accounts.length === 0) return error(400, 'Account not found');

    if (rest === 'balance' || rest === 'balance/interim' || rest === 'balance/final') {
      const rows = accounts.map((a) => ({
        acc: a.acc,
        currency: a.currency,
        balanceIn: '0.00',
        balanceInEq: '0.00',
        balanceOut: minorToDecimalString(a.balanceMinor, a.currency),
        balanceOutEq: minorToDecimalString(a.balanceMinor, a.currency),
        turnoverDebt: '0.00',
        turnoverDebtEq: '0.00',
        turnoverCred: '0.00',
        turnoverCredEq: '0.00',
        brnm: 'DNH0',
        dpd: `${dmy(today)} 00:00:00`,
        nameACC: 'ФОП Тестовий Тарас Тарасович',
        state: 'l',
        atp: 'D',
        flmn: 'DN',
        date_open_acc_reg: '28.12.2016 00:00:00',
        date_open_acc_sys: '28.12.2016 00:00:00',
        date_close_acc: '01.01.1900 00:00:00',
        is_final_bal: rest !== 'balance/interim',
      }));
      return this.page(rows, query, rest === 'balance/interim' ? 100 : 500, 'balances', 'balances');
    }

    const owned = new Set(accounts.map((a) => a.acc));
    const mine = data.items.filter((item) => owned.has(item.acc));
    if (rest === 'transactions') {
      const start = /^(\d{2})-(\d{2})-(\d{4})$/.exec(query.get('startDate') ?? '');
      if (!start) return error(400, 'startDate is required (DD-MM-YYYY)');
      const end = /^(\d{2})-(\d{2})-(\d{4})$/.exec(query.get('endDate') ?? '');
      const from = `${start[3]}-${start[2]}-${start[1]}`;
      const to = end ? `${end[3]}-${end[2]}-${end[1]}` : today;
      // Invented split, the cautious one: the interval statement stops at the last closed operating day, so today's items
      // (and holds) are only in the interim one, which starts on that same day and so repeats a day the interval one sent.
      const rows = mine
        .filter((i) => i.day >= from && i.day <= to && i.day <= data.lastDay)
        .map((i) => this.raw(i, data));
      return this.page(rows, query, 500, 'transactions', 'transactions');
    }
    if (rest === 'transactions/interim') {
      const rows = mine.filter((i) => i.day >= data.lastDay).map((i) => this.raw(i, data));
      return this.page(rows, query, 100, 'transactions', 'transactions');
    }
    if (rest === 'transactions/final') {
      const rows = mine.filter((i) => i.day === data.lastDay).map((i) => this.raw(i, data));
      return this.page(rows, query, 500, 'transactions', 'transactions');
    }
    return error(404, 'Not found');
  }

  /** The adapter's transport: no sockets, just a function from request to response. */
  readonly transport: Transport = async (url, init) => {
    const latency = this.options.latencyMs ?? 0;
    if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency));
    const parsed = new URL(url);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    const reply = this.handle(
      (init.method ?? 'GET').toUpperCase(),
      parsed.pathname,
      parsed.searchParams,
      headers,
    );
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { 'content-type': 'application/json;charset=UTF-8', ...reply.headers },
    });
  };
}
