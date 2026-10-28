import * as z from 'zod';
import { Id, IsoDateTime, ProviderId, ProviderMode } from './common';

export const SessionInfo = z.object({
  /** Short public label for the anonymous demo session; never the cookie value. */
  id: Id,
  createdAt: IsoDateTime,
  environment: z.enum(['development', 'test', 'production']),
  /** Whether the demo controls (force a bank outage, revoke at the bank, ...) are available. */
  demoControls: z.boolean(),
  providers: z.array(
    z.object({
      id: ProviderId,
      mode: ProviderMode,
      label: z.string(),
    }),
  ),
  limits: z.object({
    maxPaymentMinor: z.number().int().positive(),
    refreshCooldownSeconds: z.number().int().nonnegative(),
  }),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

/** Actions the demo panel can trigger against the mock bank. Rejected unless demo controls are on. */
export const DemoAction = z.enum([
  'bank_unavailable_next',
  'rate_limit_next',
  'revoke_at_bank',
  'expire_consent_soon',
  'expire_consent_now',
  'replay_last_webhook',
]);
export type DemoAction = z.infer<typeof DemoAction>;

export const DemoActionRequest = z.object({
  action: DemoAction,
  connectionId: Id.optional(),
  paymentId: Id.optional(),
});
export type DemoActionRequest = z.infer<typeof DemoActionRequest>;

export const DemoActionResponse = z.object({ ok: z.literal(true), message: z.string() });
export type DemoActionResponse = z.infer<typeof DemoActionResponse>;
