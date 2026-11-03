/**
 * `npm run doctor`: checks your own monobank token against the real service and tells you what works. Read-only, two calls
 * (the account list and one statement), counts only: nothing that identifies you or your money is printed or stored.
 *
 *   MONOBANK_TOKEN=... npm run doctor
 *
 * The token is read from the environment and nowhere else. Run it before connecting in the app, or wait a minute afterwards:
 * monobank allows one read a minute and both would use it.
 */
import { systemClock } from '../src/clock';
import { Calendar, addDays } from '../src/domain/calendar';
import { balanceVersusLimit, statementContinuity } from '../src/domain/checks';
import { DiagnosticsCollector } from '../src/domain/diagnostics';
import { RateTable } from '../src/domain/rates';
import { AppError } from '../src/errors';
import { EventBus } from '../src/modules/events/event-bus';
import { InspectorStore } from '../src/modules/inspector/inspector-store';
import { MonobankProvider } from '../src/providers/monobank/adapter';
import { TokenRejectedError, type ProviderAccount } from '../src/providers/port';
import { ProviderHttp, fetchTransport } from '../src/providers/transport';

const token = process.env['MONOBANK_TOKEN'];
const out = (line = ''): void => void process.stdout.write(`${line}\n`);

if (!token) {
  out(
    'Set MONOBANK_TOKEN first (your own token from https://api.monobank.ua/), then run this again:',
  );
  out('');
  out('  MONOBANK_TOKEN=... npm run doctor');
  out('');
  out('Type it yourself in your own terminal. Do not paste it into a chat.');
  process.exit(2);
}

const clock = systemClock;
const calendar = new Calendar(process.env['TIME_ZONE'] ?? 'Europe/Kyiv');
const diagnostics = new DiagnosticsCollector();
const provider = new MonobankProvider({
  id: 'monobank',
  mode: 'live',
  label: 'monobank',
  http: new ProviderHttp({
    provider: 'monobank',
    mode: 'live',
    transport: fetchTransport,
    inspector: new InspectorStore(new EventBus()),
    clock,
  }),
  apiUrl: 'https://api.monobank.ua',
  limits: {
    statementIntervalMs: 61_000,
    infoIntervalMs: 61_000,
    maxWindowDays: 31,
    maxItemsPerCall: 500,
    historyMonths: 2,
  },
  calendar,
  clock,
  diagnostics,
});
const ctx = { sessionId: 'doctor', connectionId: null };

let failures = 0;
const report = (ok: boolean | null, check: string, detail: string): void => {
  if (ok === false) failures += 1;
  out(`  ${ok === null ? 'NOTE' : ok ? 'PASS' : 'FAIL'}  ${check}${detail ? `: ${detail}` : ''}`);
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const why = (error: unknown): string =>
  error instanceof TokenRejectedError
    ? 'monobank does not accept this token (copy all of it, or issue a new one)'
    : error instanceof AppError
      ? `${error.code}${error.retryAfterSeconds ? `, wait ${error.retryAfterSeconds} s` : ''}`
      : 'unexpected error';

out('Ledger Lens doctor: real monobank, read-only, counts only\n');

let accounts: ProviderAccount[] = [];
try {
  accounts = (await provider.connect({ token }, ctx)).accounts;
  report(true, 'token accepted', `${accounts.length} accounts and jars came back`);
} catch (error) {
  report(false, 'token accepted', why(error));
  out('\nStopping: nothing else can be checked without a working token.');
  process.exit(1);
}

const cards = accounts.filter((a) => a.kind === 'card');
const jars = accounts.filter((a) => a.kind === 'jar');
const skipped = diagnostics
  .snapshot()
  .warnings.filter((w) => w.message.startsWith('client-info: skipped'));
report(
  cards.length + jars.length > 0 && skipped.length === 0,
  'accounts parsed',
  `${cards.length} cards, ${jars.length} jars${skipped.length ? `, ${skipped.reduce((n, w) => n + w.count, 0)} could not be read` : ''}`,
);

const unknown = accounts.filter((a) => a.currency.startsWith('#')).length;
let rates = new RateTable([]);
try {
  rates = new RateTable(await provider.fetchRates(ctx));
} catch (error) {
  report(false, 'exchange rates', why(error));
}
const unconverted = accounts.filter((a) => rates.perUnit(a.currency) === null).length;
report(
  unknown === 0 && unconverted === 0 && !rates.isEmpty(),
  'currencies known',
  `${new Set(accounts.map((a) => a.currency)).size} currencies, ${unknown} unknown codes, ${unconverted} accounts without a rate to UAH`,
);

const credit = cards.filter((a) => a.creditLimitMinor > 0);
const buckets = credit.map((a) => balanceVersusLimit(a.balanceMinor, a.creditLimitMinor));
const sane = accounts.every((a) => Number.isSafeInteger(a.balanceMinor));
report(
  sane,
  'own-funds math',
  credit.length === 0
    ? 'no credit cards here, so own funds = balance'
    : `${credit.length} credit card(s): balance above the limit ×${buckets.filter((b) => b === 'above').length}, equal ×${buckets.filter((b) => b === 'equal').length}, below ×${buckets.filter((b) => b === 'below').length}. Compare one with the monobank app: own funds should be balance minus limit`,
);

const main = cards.find((a) => a.currency === 'UAH') ?? cards[0] ?? accounts[0];
if (!main) {
  report(false, 'statement parsed', 'there is no account to read');
} else {
  const today = calendar.today(clock.now());
  const window = { from: addDays(today, -30), to: today };
  let rows = null;
  for (let attempt = 0; attempt < 2 && rows === null; attempt += 1) {
    try {
      rows = await provider.fetchTransactions(
        { accessToken: token },
        { providerAccountId: main.providerAccountId, currency: main.currency },
        window,
        ctx,
      );
    } catch (error) {
      if (error instanceof AppError && error.code === 'rate_limited' && attempt === 0) {
        out('  ...      monobank allows one read a minute; waiting 61 seconds for the statement');
        await sleep(61_000);
      } else {
        report(false, 'statement parsed', why(error));
        break;
      }
    }
  }
  if (rows !== null) {
    const bad = diagnostics
      .snapshot()
      .warnings.filter((w) => w.message.startsWith('statement: skipped'));
    report(
      bad.length === 0,
      'statement parsed',
      `${rows.length} rows in the last 31 days${bad.length ? `, ${bad.reduce((n, w) => n + w.count, 0)} could not be read` : ''}, ${rows.filter((r) => r.status === 'pending').length} on hold, ${rows.filter((r) => r.cashbackMinor > 0).length} with cashback`,
    );
    const { pairs, consistent } = statementContinuity(
      rows.map((r) => ({
        ts: r.ts,
        amountMinor: r.amountMinor,
        balanceAfterMinor: r.balanceAfterMinor,
        pending: r.status === 'pending',
      })),
    );
    report(
      pairs < 5 ? null : consistent / pairs >= 0.95,
      'statement balance is the balance after each item',
      pairs < 5
        ? 'too few rows to tell'
        : `${consistent} of ${pairs} consecutive pairs agree (${Math.round((consistent / pairs) * 100)}%)`,
    );
  }
}

out(
  failures === 0
    ? '\nAll checks passed. Connect it in the app.'
    : `\n${failures} check(s) failed. Run "Copy diagnostics" in the app, or send this output: it contains no personal data.`,
);
process.exit(failures === 0 ? 0 : 1);
