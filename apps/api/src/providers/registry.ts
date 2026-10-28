import type { ProviderId } from '@ledger-lens/contracts';
import { AppError } from '../errors';
import type { App, CoreContext } from '../types';
import { MockProvider } from './mock/adapter';
import { registerMockBank } from './mock/bank';
import { MockBankStore } from './mock/store';
import { createMockTransport } from './mock/transport';
import type { BankingProvider } from './port';
import { ProviderHttp } from './transport';

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
    if (separator < 1 || !['mock', 'truelayer', 'enablebanking'].includes(id)) {
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

export interface RegistryDeps {
  app: App;
  ctx: Pick<CoreContext, 'config' | 'clock' | 'db' | 'inspector'>;
}

/** Builds the adapters the configuration enables. An adapter without credentials is simply not registered. */
export async function buildRegistry({ app, ctx }: RegistryDeps): Promise<ProviderRegistry> {
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

  return new ProviderRegistry(providers);
}
