import type { Clock } from '@api/clock';
import type { Calendar } from '@api/domain/calendar';
import { DiagnosticsCollector } from '@api/domain/diagnostics';
import { MonobankProvider } from '@api/providers/monobank/adapter';
import { DEMO_TOKEN, FakeMonobank } from '@api/providers/monobank/demo/fake';
import type { BankingProvider, ProviderLimits } from '@api/providers/port';
import { PhoneHttp, fetchWire, type Wire } from './http';

export const MONOBANK_API = 'https://api.monobank.ua';

/** monobank allows one read a minute per endpoint and 31 days a statement; three months of history is about 3 minutes a card. */
export const MONOBANK_LIMITS: ProviderLimits = {
  statementIntervalMs: 60_000,
  infoIntervalMs: 60_000,
  maxWindowDays: 31,
  maxItemsPerCall: 500,
  historyMonths: 3,
};

export { DEMO_TOKEN };

export interface Bank {
  provider: BankingProvider;
  demo: boolean;
}

/** The server's monobank adapter, unchanged, on the phone's read-only HTTP. */
export function liveBank(
  clock: Clock,
  calendar: Calendar,
  wire: Wire = fetchWire,
  limits: ProviderLimits = MONOBANK_LIMITS,
): Bank {
  const provider = new MonobankProvider({
    id: 'monobank',
    mode: 'live',
    label: 'monobank',
    http: new PhoneHttp(wire, MONOBANK_API).asProviderHttp(),
    apiUrl: MONOBANK_API,
    limits,
    calendar,
    clock,
    diagnostics: new DiagnosticsCollector(),
  });
  return { provider, demo: false };
}

const DEMO_API = 'https://demo.monobank.invalid';

/** The fake bank answering in-process: no socket is opened, the address never resolves. */
export function fakeWire(fake: FakeMonobank, origin: string = DEMO_API): Wire {
  return (url, init) => {
    const path = url.slice(origin.length).split('?')[0] ?? '/';
    const reply = fake.handle(init.method, path, init.headers['x-token']);
    const headers = new Map(Object.entries(reply.headers ?? {}));
    return Promise.resolve({
      status: reply.status,
      headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
      text: () => Promise.resolve(JSON.stringify(reply.body)),
    });
  };
}

/** The same adapter on the made-up customer, so what the demo shows went through the code a real token uses. No network at all. */
export function demoBank(clock: Clock, calendar: Calendar): Bank {
  const fake = new FakeMonobank({ clock, calendar, limits: null });
  const provider = new MonobankProvider({
    id: 'demo',
    mode: 'demo',
    label: 'Demo bank',
    http: new PhoneHttp(fakeWire(fake), DEMO_API).asProviderHttp(),
    apiUrl: DEMO_API,
    limits: { ...MONOBANK_LIMITS, statementIntervalMs: 0, infoIntervalMs: 0 },
    calendar,
    clock,
    diagnostics: new DiagnosticsCollector(),
  });
  return { provider, demo: true };
}
