import * as z from 'zod';
import { Currency, ProviderId, ProviderMode } from './common';

export const Institution = z.object({
  /** `<provider>:<slug>`, unique across providers, e.g. `mock:mock-bank`. */
  id: z.string(),
  provider: ProviderId,
  mode: ProviderMode,
  name: z.string(),
  country: z.string().length(2),
  currencies: z.array(Currency),
  logoUrl: z.string().nullable(),
  capabilities: z.object({
    accounts: z.boolean(),
    payments: z.boolean(),
  }),
  /** `degraded` banks are listed but connecting will most likely fail (the mock "unhealthy" bank). */
  health: z.enum(['operational', 'degraded']),
  /** Shown on the payment form when this bank's payments behave in a way a reader should know about. */
  paymentsNote: z.string().nullable(),
});
export type Institution = z.infer<typeof Institution>;

export const InstitutionList = z.object({ items: z.array(Institution) });
export type InstitutionList = z.infer<typeof InstitutionList>;

export const InstitutionQuery = z.object({
  country: z.string().length(2).optional(),
  q: z.string().trim().max(60).optional(),
});
export type InstitutionQuery = z.infer<typeof InstitutionQuery>;
