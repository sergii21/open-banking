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
import { PrivatBankProvider } from './privatbank/adapter';
import { WiseProvider } from './wise/adapter';
import { ProviderHttp, fetchTransport, type Transport } from './transport';

/** The real bank's address, for the public rates the demo shows. */
const REAL_API = 'https://api.monobank.ua';

/**
 * The enabled adapters: `monobank` and `privatbank` (the person's own accounts, local only) and `demo` (the monobank adapter on
 * a fake bank). `privat24`, an imported statement file, has no adapter: it only has a place to record what the importer saw.
 */
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
  privatbank?: Transport;
  wise?: Transport;
  demo?: Transport;
  /** Waits between PrivatBank requests; tests move their clock instead of the wall clock. */
  pause?: (ms: number) => Promise<void>;
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
  collectors.set('privat24', new DiagnosticsCollector());

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

    // PrivatBank publishes no rates it lets a business key read for this, so every bank values foreign money at monobank's
    // public rates (no token involved); a statement file does too.
    const privatDiagnostics = new DiagnosticsCollector();
    collectors.set('privatbank', privatDiagnostics);
    providers.set(
      'privatbank',
      new PrivatBankProvider({
        id: 'privatbank',
        mode: 'live',
        label: 'PrivatBank business',
        http: new ProviderHttp({
          provider: 'privatbank',
          mode: 'live',
          transport: transports.privatbank ?? fetchTransport,
          inspector,
          clock,
        }),
        apiUrl: config.privatbank.apiUrl,
        limits: {
          statementIntervalMs: config.privatbank.intervalMs,
          infoIntervalMs: config.privatbank.intervalMs,
          maxWindowDays: 31,
          // Rows come in pages that the adapter follows to the end, so a response is never "cut short".
          maxItemsPerCall: Number.MAX_SAFE_INTEGER,
          historyMonths: config.privatbank.historyMonths,
          sharedLimit: true,
        },
        calendar,
        clock,
        diagnostics: privatDiagnostics,
        ...(transports.pause ? { pause: transports.pause } : {}),
      }),
    );
    rateSources.set('privatbank', [live]);
    // Wise: balances in the background (drafts only when the person asks), valued at monobank's public rates like every other bank.
    const wiseDiagnostics = new DiagnosticsCollector();
    collectors.set('wise', wiseDiagnostics);
    providers.set(
      'wise',
      new WiseProvider({
        id: 'wise',
        mode: 'live',
        label: 'Wise',
        http: new ProviderHttp({
          provider: 'wise',
          mode: 'live',
          transport: transports.wise ?? fetchTransport,
          inspector,
          clock,
        }),
        apiUrl: config.wise.apiUrl,
        limits: {
          statementIntervalMs: config.wise.intervalMs,
          infoIntervalMs: config.wise.intervalMs,
          maxWindowDays: 31,
          maxItemsPerCall: Number.MAX_SAFE_INTEGER,
          historyMonths: 1,
          sharedLimit: true,
          balancesOnly: true,
        },
        clock,
        diagnostics: wiseDiagnostics,
        ...(transports.pause ? { pause: transports.pause } : {}),
      }),
    );
    rateSources.set('wise', [live]);
    rateSources.set('privat24', [live]);
  }

  // The demo: the same adapter, its transport pointed at an in-process fake, pacing off.
  const fake = new FakeMonobank({
    clock,
    calendar,
    latencyMs: demoLatencyMs,
    historyDays: config.demo.historyDays,
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
