import * as z from 'zod';
import { Id, IsoDateTime, ProviderId, ProviderMode } from './common';

export const ConnectionStatus = z.enum([
  'pending',
  'active',
  'expired',
  'revoked',
  'needs_reauth',
  'error',
]);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

/** What the user has agreed to share. Shown on the consent explainer and the connections page. */
export const Permission = z.enum(['accounts', 'balances', 'transactions']);
export type Permission = z.infer<typeof Permission>;

export const ConsentState = z.enum(['valid', 'expiring_soon', 'expired', 'none']);
export type ConsentState = z.infer<typeof ConsentState>;

export const Connection = z.object({
  id: Id,
  provider: ProviderId,
  mode: ProviderMode,
  institutionId: z.string(),
  institutionName: z.string(),
  institutionLogoUrl: z.string().nullable(),
  status: ConnectionStatus,
  permissions: z.array(Permission),
  createdAt: IsoDateTime,
  /** When the bank consent ends (PSD2 consents last up to 180 days; UK banks use 90-day reconfirmation). */
  consentExpiresAt: IsoDateTime.nullable(),
  consentState: ConsentState,
  consentDaysRemaining: z.number().int().nullable(),
  lastRefreshedAt: IsoDateTime.nullable(),
  accountCount: z.number().int().nonnegative(),
});
export type Connection = z.infer<typeof Connection>;

export const ConnectionList = z.object({ items: z.array(Connection) });
export type ConnectionList = z.infer<typeof ConnectionList>;

export const CreateConnectionRequest = z.object({
  institutionId: z.string().min(1),
  /** Reconnect: reuse an existing connection row instead of creating a second one. */
  reconnectConnectionId: Id.optional(),
});
export type CreateConnectionRequest = z.infer<typeof CreateConnectionRequest>;

export const CreateConnectionResponse = z.object({
  connectionId: Id,
  authUrl: z.string(),
});
export type CreateConnectionResponse = z.infer<typeof CreateConnectionResponse>;

/** Where `/connect/result` is told the outcome of the bank redirect. */
export const ConnectOutcome = z.enum([
  'success',
  'denied',
  'timeout',
  'unavailable',
  'invalid_state',
  'error',
]);
export type ConnectOutcome = z.infer<typeof ConnectOutcome>;
