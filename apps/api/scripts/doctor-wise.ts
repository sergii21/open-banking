/**
 * `npm run doctor:wise`: checks your own Wise personal API token against the real service and tells you what works. Read-only,
 * two GET requests (the profile list, then each profile's balances), counts only: nothing that identifies you or your money is
 * printed or stored. Statements are never requested (Wise wants strong authentication for them outside US, CA, AU, NZ, SG, MY).
 *
 *   WISE_TOKEN=... npm run doctor:wise
 *
 * The token is read from the environment and nowhere else.
 */
import { systemClock } from '../src/clock';
import { DiagnosticsCollector } from '../src/domain/diagnostics';
import { AppError } from '../src/errors';
import { EventBus } from '../src/modules/events/event-bus';
import { InspectorStore } from '../src/modules/inspector/inspector-store';
import { TokenRejectedError, type ProviderAccount } from '../src/providers/port';
import { ProviderHttp, fetchTransport } from '../src/providers/transport';
import { WiseProvider } from '../src/providers/wise/adapter';

const token = process.env['WISE_TOKEN'];
const out = (line = ''): void => void process.stdout.write(`${line}\n`);

if (!token) {
  out('Set WISE_TOKEN first (the personal API token you created in Wise), then run this again:');
  out('');
  out('  WISE_TOKEN=... npm run doctor:wise');
  out('');
  out('Type it yourself in your own terminal. Do not paste it into a chat.');
  process.exit(2);
}

const diagnostics = new DiagnosticsCollector();
const provider = new WiseProvider({
  id: 'wise',
  mode: 'live',
  label: 'Wise',
  http: new ProviderHttp({
    provider: 'wise',
    mode: 'live',
    transport: fetchTransport,
    inspector: new InspectorStore(new EventBus()),
    clock: systemClock,
  }),
  apiUrl: process.env['WISE_API_URL'] ?? 'https://api.wise.com/2026Q4',
  limits: {
    statementIntervalMs: 1000,
    infoIntervalMs: 1000,
    maxWindowDays: 31,
    maxItemsPerCall: Number.MAX_SAFE_INTEGER,
    historyMonths: 1,
    sharedLimit: true,
    balancesOnly: true,
  },
  clock: systemClock,
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
    ? 'Wise does not accept this token (copy all of it, or create a new one)'
    : error instanceof AppError
      ? `${error.code}: ${error.message}`
      : 'unexpected error';

out('Ledger Lens doctor: real Wise, read-only, balances only, counts only\n');

let accounts: ProviderAccount[] = [];
try {
  accounts = (await provider.connect({ token }, ctx)).accounts;
  report(true, 'token accepted', `${accounts.length} balances came back`);
} catch (error) {
  report(false, 'token accepted', why(error));
  out('\nStopping: nothing else can be checked without a working token.');
  process.exit(1);
}

const snapshot = diagnostics.snapshot();
const profiles = snapshot.shapes.find((s) => s.path === 'profiles');
report(
  (profiles?.rows ?? 0) > 0,
  'profiles',
  `${profiles?.rows ?? 0} profile(s); the account type (personal or business) is not printed, compare in Wise`,
);
const jars = accounts.filter((a) => a.kind === 'jar').length;
report(
  accounts.length > 0 && accounts.every((a) => Number.isSafeInteger(a.balanceMinor)),
  'balances parsed',
  `${accounts.length - jars} currency balances, ${jars} jars, currencies: ${[...new Set(accounts.map((a) => a.currency))].join(', ') || 'none'}; all whole minor units`,
);
report(
  null,
  'balance is the available balance',
  'compare each balance in Ledger Lens with Wise: they should match (the app reads amount, the available balance)',
);
report(
  null,
  'history',
  'not read by design: the statement endpoint needs strong authentication (403 with X-2FA headers) outside US, CA, AU, NZ, SG, MY',
);
out('\nCalls');
for (const e of snapshot.endpoints) out(`  ${e.name}: ${e.calls} calls, statuses ${e.statuses}`);
out('\nFields Wise sent that Ledger Lens does not use (names only)');
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
    : `\n${failures} check(s) failed. This output contains no personal data.`,
);
process.exit(failures === 0 ? 0 : 1);
