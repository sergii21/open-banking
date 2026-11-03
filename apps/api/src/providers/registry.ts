import type { ProviderId } from '@ledger-lens/contracts';
import type { Clock } from '../clock';
import type { AppConfig } from '../config';
import { type Calendar } from '../domain/calendar';
import { DiagnosticsCollector } from '../domain/diagnostics';
import { AppError } from '../errors';
import type { InspectorStore } from '../modules/inspector/inspector-store';
import type { BankingProvider } from './port';
import { MonobankProvider } from './monobank/adapter';
import { FakeMonobank } from './monobank/demo/fake';
import { ProviderHttp, fetchTransport, type Transport } from './transport';

/** The real bank's address, for the public rates the demo shows. */
const REAL_API = 'https://api.monobank.ua';

/** The enabled adapters: `monobank` (the person's own account, local only) and `demo` (the same adapter on a fake bank). */
export class ProviderRegistry {
  constructor(
    private readonly providers: ReadonlyMap<ProviderId, BankingProvider>,
    /** Where to ask for rates, in order, per provider. The demo asks the real bank first and its own fake second. */
    private readonly rateSources: ReadonlyMap<ProviderId, readonly BankingProvider[]>,
    private readonly collectors: ReadonlyMap<ProviderId, DiagnosticsCollector>,
    /** The in-process fake, when the demo is on: tests and the demo controls reach it here. */
    readonly fake: FakeMonobank | null,
  ) {}

  all(): BankingProvider[] {
    return [...this.providers.values()];
  }

  has(id: ProviderId): boolean {
    return this.providers.has(id);
  }

  get(id: ProviderId): BankingProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new AppError('provider_not_available', 404, `${id} is not available here.`);
    }
    return provider;
  }

  ratesFrom(id: ProviderId): readonly BankingProvider[] {
    return this.rateSources.get(id) ?? [];
  }

  diagnostics(id: ProviderId): DiagnosticsCollector {
    return this.collectors.get(id) ?? new DiagnosticsCollector();
  }
}

/** Tests replace the network with a scripted bank; production uses `fetch`. */
export interface ProviderTransports {
  monobank?: Transport;
  demo?: Transport;
}

export interface RegistryDeps {
  config: AppConfig;
  clock: Clock;
  inspector: InspectorStore;
  calendar: Calendar;
  transports?: ProviderTransports;
  /** The demo fake's latency; the server uses a little so loading states are real, tests use none. */
  demoLatencyMs?: number;
}

export function buildRegistry({
  config,
  clock,
  inspector,
  calendar,
  transports = {},
  demoLatencyMs = 0,
}: RegistryDeps): ProviderRegistry {
  const providers = new Map<ProviderId, BankingProvider>();
  const rateSources = new Map<ProviderId, BankingProvider[]>();
  const collectors = new Map<ProviderId, DiagnosticsCollector>();

  if (config.live) {
    const diagnostics = new DiagnosticsCollector();
    collectors.set('monobank', diagnostics);
    const live = new MonobankProvider({
      id: 'monobank',
      mode: 'live',
      label: 'monobank',
      http: new ProviderHttp({
        provider: 'monobank',
        mode: 'live',
        transport: transports.monobank ?? fetchTransport,
        inspector,
        clock,
      }),
      apiUrl: config.monobank.apiUrl,
      limits: {
        statementIntervalMs: config.monobank.statementIntervalMs,
        infoIntervalMs: config.monobank.infoIntervalMs,
        maxWindowDays: 31,
        maxItemsPerCall: 500,
        historyMonths: config.monobank.historyMonths,
      },
      calendar,
      clock,
      diagnostics,
    });
    providers.set('monobank', live);
    rateSources.set('monobank', [live]);
  }

  // The demo: the same adapter, its transport pointed at an in-process fake, pacing off.
  const fake = new FakeMonobank({
    clock,
    calendar,
    latencyMs: demoLatencyMs,
    limits:
      config.demo.statementIntervalMs > 0
        ? { statementMs: config.demo.statementIntervalMs, infoMs: config.demo.infoIntervalMs }
        : null,
  });
  const demoDiagnostics = new DiagnosticsCollector();
  collectors.set('demo', demoDiagnostics);
  const demoDeps = {
    id: 'demo' as const,
    label: 'Demo bank',
    calendar,
    clock,
    diagnostics: demoDiagnostics,
    limits: {
      statementIntervalMs: config.demo.statementIntervalMs,
      infoIntervalMs: config.demo.infoIntervalMs,
      maxWindowDays: 31,
      maxItemsPerCall: 500,
      historyMonths: config.demo.historyMonths,
    },
  };
  const demo = new MonobankProvider({
    ...demoDeps,
    mode: 'demo',
    http: new ProviderHttp({
      provider: 'demo',
      mode: 'demo',
      transport: transports.demo ?? fake.transport,
      inspector,
      clock,
    }),
    apiUrl: 'https://demo.monobank.invalid',
  });
  providers.set('demo', demo);
  // Exchange rates are public, so even the demo shows the real ones (and says where they come from in the Live API drawer).
  const sources: BankingProvider[] = [];
  if (config.demoRealRates) {
    sources.push(
      new MonobankProvider({
        ...demoDeps,
        mode: 'live',
        http: new ProviderHttp({
          provider: 'demo',
          mode: 'live',
          transport: fetchTransport,
          inspector,
          clock,
        }),
        apiUrl: REAL_API,
      }),
    );
  }
  sources.push(demo);
  rateSources.set('demo', sources);

  return new ProviderRegistry(providers, rateSources, collectors, fake);
}
