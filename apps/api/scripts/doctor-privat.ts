/**
 * `npm run doctor:privat`: checks your own PrivatBank (business / ФОП) key against the real Autoclient service and tells you
 * what works. Read-only, a handful of requests at the bank's pace of one a second, counts only: nothing that identifies you or
 * your money is printed or stored.
 *
 *   PRIVATBANK_TOKEN=... npm run doctor:privat
 *
 * The token is read from the environment and nowhere else. This is how the assumptions that could only be made from the
 * published document (what `balance/interim` returns, what the interval statement holds for today, the PR_PR and FL_REAL
 * values, the time of an item) get checked against the real service.
 */
import { systemClock } from '../src/clock';
import { Calendar, addDays } from '../src/domain/calendar';
import { DiagnosticsCollector } from '../src/domain/diagnostics';
import { AppError } from '../src/errors';
import { EventBus } from '../src/modules/events/event-bus';
import { InspectorStore } from '../src/modules/inspector/inspector-store';
import { TokenRejectedError, type ProviderAccount } from '../src/providers/port';
import { PrivatBankProvider } from '../src/providers/privatbank/adapter';
import { ProviderHttp, fetchTransport } from '../src/providers/transport';

const token = process.env['PRIVATBANK_TOKEN'];
const out = (line = ''): void => void process.stdout.write(`${line}\n`);

if (!token) {
  out(
    'Set PRIVATBANK_TOKEN first (the key you created in Privat24 for Business), then run this again:',
  );
  out('');
  out('  PRIVATBANK_TOKEN=... npm run doctor:privat');
  out('');
  out('Type it yourself in your own terminal. Do not paste it into a chat.');
  process.exit(2);
}

const clock = systemClock;
const calendar = new Calendar(process.env['TIME_ZONE'] ?? 'Europe/Kyiv');
const diagnostics = new DiagnosticsCollector();
const provider = new PrivatBankProvider({
  id: 'privatbank',
  mode: 'live',
  label: 'PrivatBank business',
  http: new ProviderHttp({
    provider: 'privatbank',
    mode: 'live',
    transport: fetchTransport,
    inspector: new InspectorStore(new EventBus()),
    clock,
  }),
  apiUrl: process.env['PRIVATBANK_API_URL'] ?? 'https://acp.privatbank.ua',
  limits: {
    statementIntervalMs: 1100,
    infoIntervalMs: 1100,
    maxWindowDays: 31,
    maxItemsPerCall: Number.MAX_SAFE_INTEGER,
    historyMonths: 2,
    sharedLimit: true,
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
const why = (error: unknown): string =>
  error instanceof TokenRejectedError
    ? 'PrivatBank does not accept this key (copy all of it, or create a new one)'
    : error instanceof AppError
      ? `${error.code}: ${error.message}`
      : 'unexpected error';

out('Ledger Lens doctor: real PrivatBank Autoclient, read-only, counts only\n');

let accounts: ProviderAccount[] = [];
try {
  accounts = (await provider.connect({ token }, ctx)).accounts;
  report(true, 'key accepted and the bank is open', `${accounts.length} accounts came back`);
} catch (error) {
  report(false, 'key accepted and the bank is open', why(error));
  out('\nStopping: nothing else can be checked without a working key.');
  process.exit(1);
}

report(
  accounts.length > 0,
  'accounts parsed',
  `${accounts.map((a) => a.currency).join(', ') || 'none'}; balances ${accounts.every((a) => Number.isSafeInteger(a.balanceMinor)) ? 'are whole minor units' : 'are NOT whole numbers'}`,
);
report(
  null,
  'balance is the balance now',
  'compare each account’s balance in Ledger Lens with Privat24: they should match to the kopiyka (the app reads balance/interim)',
);

const main = accounts.find((a) => a.currency === 'UAH') ?? accounts[0];
if (!main) {
  report(false, 'statement parsed', 'there is no account to read');
} else {
  const today = calendar.today(clock.now());
  try {
    const rows = await provider.fetchTransactions(
      { accessToken: token },
      { providerAccountId: main.providerAccountId, currency: main.currency },
      { from: addDays(today, -30), to: today },
      ctx,
    );
    const warnings = diagnostics.snapshot().warnings.map((w) => w.message);
    const skipped = (needle: string): number =>
      diagnostics
        .snapshot()
        .warnings.filter((w) => w.message.includes(needle))
        .reduce((n, w) => n + w.count, 0);
    const requests = diagnostics
      .snapshot()
      .endpoints.filter((e) => e.name.startsWith('transactions'))
      .map((e) => `${e.name} ×${e.calls}`)
      .join(', ');
    report(true, 'statement parsed', `${rows.length} items in the last 31 days (${requests})`);
    report(
      rows.every((r) => Number.isSafeInteger(r.amountMinor)),
      'amounts',
      `${rows.filter((r) => r.amountMinor < 0).length} out, ${rows.filter((r) => r.amountMinor > 0).length} in, ${rows.filter((r) => r.status === 'pending').length} in progress`,
    );
    report(
      null,
      'items left out',
      `${skipped('reversed')} reversed, ${skipped('rejected')} rejected, ${skipped('not-real')} not real (FL_REAL i), ${skipped('without')} unreadable. If "not real" is high, FL_REAL i may mean something else`,
    );
    const future = rows.filter((r) => r.ts > clock.now().getTime() + 86_400_000).length;
    report(
      future === 0,
      'times',
      `${future} items dated more than a day ahead (would mean the time zone is read wrongly)`,
    );
    const todays = rows.filter((r) => calendar.dayKey(r.ts) === today).length;
    report(
      null,
      'today',
      `${todays} items dated today. If you made a payment today and it is missing, the interval statement and the interim one disagree`,
    );
    report(
      warnings.every((w) => !w.includes('unexpected status')),
      'no unexpected answers',
      warnings.some((w) => w.includes('unexpected status'))
        ? 'the bank answered with a status the document does not describe (see below)'
        : 'every answer was one the document describes',
    );
  } catch (error) {
    report(false, 'statement parsed', why(error));
  }
}

const snapshot = diagnostics.snapshot();
out('\nCalls');
for (const e of snapshot.endpoints) out(`  ${e.name}: ${e.calls} calls, statuses ${e.statuses}`);
out('\nFields the bank sent that Ledger Lens does not use (names only)');
for (const shape of snapshot.shapes) {
  out(`  ${shape.path}: ${shape.unknown.length ? shape.unknown.join(', ') : 'none'}`);
}
if (snapshot.warnings.length > 0) {
  out('\nRows or answers we could not use');
  for (const w of snapshot.warnings) out(`  ${w.count}× ${w.message}`);
}

out(
  failures === 0
    ? '\nAll checks passed. Connect it in the app.'
    : `\n${failures} check(s) failed. Run "Copy diagnostics" in the app, or send this output: it contains no personal data.`,
);
process.exit(failures === 0 ? 0 : 1);
