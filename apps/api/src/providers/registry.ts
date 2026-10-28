import { ProviderId } from '@ledger-lens/contracts';
import { AppError } from '../errors';
import type { App, CoreContext } from '../types';
import { MockProvider } from './mock/adapter';
import { registerMockBank } from './mock/bank';
import { MockBankStore } from './mock/store';
import { createMockTransport } from './mock/transport';
import type { BankingProvider } from './port';
import { MonobankProvider } from './monobank/adapter';
import { TrueLayerProvider } from './truelayer/adapter';
import { ProviderHttp, fetchTransport, type Transport } from './transport';

/** The enabled adapters, and the lookup from an institution id (`<provider>:<slug>`) to its adapter. */
export class ProviderRegistry {
  constructor(private readonly providers: ReadonlyMap<ProviderId, BankingProvider>) {}

  all(): BankingProvider[] {
    return [...this.providers.values()];
  }

  has(id: ProviderId): boolean {
    return this.providers.has(id);
  }

  get(id: ProviderId): BankingProvider {
    const provider = this.providers.get(id);
    if (!provider)
      throw new AppError('provider_not_available', 404, `The ${id} provider is not enabled.`);
    return provider;
  }

  resolveInstitution(institutionId: string): { provider: BankingProvider; slug: string } {
    const separator = institutionId.indexOf(':');
    const id = institutionId.slice(0, separator);
    if (separator < 1 || !ProviderId.safeParse(id).success) {
      throw new AppError('provider_not_available', 404, 'That bank is not available.');
    }
    return { provider: this.get(id as ProviderId), slug: institutionId.slice(separator + 1) };
  }

  /** The mock adapter exposes demo hooks; other providers do not. */
  mock(): MockProvider | null {
    const provider = this.providers.get('mock');
    return provider instanceof MockProvider ? provider : null;
  }
}

/** Tests replace the network with a scripted provider; production uses `fetch`. */
export interface ProviderTransports {
  truelayer?: Transport;
  monobank?: Transport;
}

export interface RegistryDeps {
  app: App;
  ctx: Pick<CoreContext, 'config' | 'clock' | 'db' | 'inspector'>;
  transports?: ProviderTransports;
}

/** Builds the adapters the configuration enables. An adapter without credentials is simply not registered. */
export async function buildRegistry({
  app,
  ctx,
  transports = {},
}: RegistryDeps): Promise<ProviderRegistry> {
  const providers = new Map<ProviderId, BankingProvider>();

  if (ctx.config.providers.mock.enabled) {
    const store = new MockBankStore(ctx.db, ctx.clock);
    await registerMockBank(app, ctx, store);
    providers.set(
      'mock',
      new MockProvider({
        http: new ProviderHttp({
          provider: 'mock',
          mode: 'mock',
          transport: createMockTransport(app),
          inspector: ctx.inspector,
          clock: ctx.clock,
        }),
        publicUrl: ctx.config.publicUrl,
        clock: ctx.clock,
        store,
      }),
    );
  }

  const truelayer = ctx.config.providers.truelayer;
  if (truelayer) {
    providers.set(
      'truelayer',
      new TrueLayerProvider({
        http: new ProviderHttp({
          provider: 'truelayer',
          mode: 'sandbox',
          transport: transports.truelayer ?? fetchTransport,
          inspector: ctx.inspector,
          clock: ctx.clock,
        }),
        config: truelayer,
        clock: ctx.clock,
      }),
    );
  }

  const monobank = ctx.config.providers.monobank;
  if (monobank) {
    providers.set(
      'monobank',
      new MonobankProvider({
        http: new ProviderHttp({
          provider: 'monobank',
          mode: 'live',
          transport: transports.monobank ?? fetchTransport,
          inspector: ctx.inspector,
          clock: ctx.clock,
        }),
        config: monobank,
        clock: ctx.clock,
      }),
    );
  }

  return new ProviderRegistry(providers);
}
